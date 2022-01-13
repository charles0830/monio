"use strict";

var {
	isFunction,
	isPromise,
	isMonad,
	getMonadFlatMap,
} = require("../lib/util.js");
var Nothing = require("../nothing.js");
var Either = require("../either.js");

const BRAND = {};
const IS_CONT = Symbol("is-continuation");
const RUN_CONT = Symbol("return-continuation");
const CONT_VAL = Symbol("continuation-value");

module.exports = Object.assign(IO,{
	of, pure: of, unit: of, is, do: $do, doEither, fromIOx,
	_IS_CONT: IS_CONT,
});
module.exports.RIO = IO;
module.exports.of = of;
module.exports.pure = of;
module.exports.unit = of;
module.exports.is = is;
module.exports.do = $do;
module.exports.doEither = doEither;
module.exports.fromIOx = fromIOx;
module.exports._IS_CONT = IS_CONT;


// **************************

function IO(effect) {
	var publicAPI = {
		map, chain, flatMap: chain, bind: chain,
		concat, run, _inspect, _is,
		[Symbol.toStringTag]: "IO",
	};
	return publicAPI;

	// *****************************************

	function map(fn) {
		return IO(env => continuation([
			() => effect(env),
			res => (isPromise(res) ? res.then(fn) : fn(res))
		]));
	}

	function chain(fn) {
		return IO(env => continuation([
			() => effect(env),
			res => {
				var res2 = (isPromise(res) ? res.then(fn) : fn(res));
				return (isPromise(res2) ?
					res2.then(v => v.run(env)) :
					res2.run(returnRunContinuation(env))
				);
			}
		]));
	}

	function concat(m) {
		return IO(env => continuation([
			() => effect(env),
			res1 => {
				var res2 = m.run(env);
				return (
					(isPromise(res1) || isPromise(res2)) ?
						(
							Promise.all([ res1, res2, ])
							.then(([ v1, v2, ]) => v1.concat(v2))
						) :
						res1.concat(res2)
				);
			}
		]));
	}

	function run(env) {
		if (env && env[RUN_CONT] === true) {
			return effect(env.env);
		}
		else {
			return trampoline(effect(env));
		}
	}

	function _inspect() {
		return `${publicAPI[Symbol.toStringTag]}(${
			isFunction(effect) ? (effect.name || "anonymous function") :
			String(effect)
		})`;
	}

	function _is(br) {
		return br === BRAND;
	}

}

function of(v) {
	return IO(() => v);
}

function is(v) {
	return !!(v && isFunction(v._is) && v._is(BRAND));
}

function processNext(next,respVal,outerEnv,throwEither) {
	return (isPromise(respVal) ?

		// trampoline()s here unwrap the continuations
		// immediately, because we're already in an
		// async microtask from the promise
		safeUnwrap(respVal,throwEither).then(
			([nrv,type]) => trampoline(handleNextRespVal(nrv,type))
		)
		.catch(err => trampoline(handleNextRespVal(err,"error"))) :

		handleNextRespVal(
			respVal,
			(
				(throwEither && Either.Left.is(respVal)) ?
					"error" :
					"value"
			)
		)
	);


	// ***********************************************************

	function handleNextRespVal(nextRespVal,unwrappedType) {
		// construct chained IO
		var chainNextFn = v => (
			IO(() => next(v,unwrappedType))
		);

		var m = (
			// Nothing monad (should short-circuit to no-op)?
			Nothing.is(nextRespVal) ? IO.of() :

			// IOx monad? (unfortunately, cannot use `IOx.is(..)`
			// brand check because it creates a circular dependency
			// between IO and IOx
			!!(
				nextRespVal &&
				isFunction(nextRespVal) &&
				isFunction(nextRespVal._chain_with_IO) &&
				isFunction(nextRespVal._inspect) &&
				/^IOx\b/.test(nextRespVal._inspect())
			) ?
				// chain IOx via a regular IO to reduce overhead
				nextRespVal._chain_with_IO(chainNextFn) :

			// otherwise, chain the generic monad
			monadFlatMap(
				(
					// ensure we're chaining to a monad
					(
						// need to wrap Either:Left error?
						(
							throwEither &&
							unwrappedType == "error" &&
							Either.Left.is(nextRespVal)
						) ||

						// need to lift non-monad?
						!isMonad(nextRespVal)
					) ?
						// wrap it in an IO
						IO.of(nextRespVal) :

						// otherwise, must already be a monad
						nextRespVal
				),
				// chain/flatMap the monad to the "next" IO step
				chainNextFn
			)
		);

		return continuation([
			() => m.run(returnRunContinuation(outerEnv)),
			v => v
		]);
	}
}

function $do($V,...args) {
	return IO(outerEnv => {
		var it = getIterator($V,outerEnv,/*outerThis=*/this,args);

		return trampoline(
			next(),
			err => trampoline(next(err,"error"),liftDoError)
		);

		// ************************************************

		function next(v,type) {
			try {
				var resp = (
					type === "error" ?
						it.throw(v) :
						it.next(v)
				);

				return (
					// iterator from an async generator?
					isPromise(resp) ?

						// trampoline()s here unwrap the continuations
						// immediately, because we're already in an
						// async microtask from the promise
						resp.then(
							v => trampoline(handleResp(v)),
							err => trampoline(handleError(err))
						) :

						handleResp(resp)
				);


				// ***********************************************

				function handleResp(resp) {
					// is the iterator done?
					if (resp.done) {
						return continuation([
							() => {
								try {
									// if an IO was returned, automatically run it
									// as if it was yielded before returning
									return (
										IO.is(resp.value) ?
											resp.value.run(returnRunContinuation(outerEnv)) :
											resp.value
									);
								}
								catch (err) {
									return liftDoError(err);
								}
							},
							v => v
						]);
					}
					// otherwise, move onto the next step
					else {
						return processNext(next,resp.value,outerEnv,/*throwEither=*/false);
					}
				}

				function handleError(err) {
					// already tried to throw the error in?
					if (type == "error") {
						return liftDoError(err);
					}
					// otherwise, at least try to throw
					// the error back in
					else {
						return next(err,"error");
					}
				}
			}
			catch (err) {
				return liftDoError(err);
			}
		}
	});
}

function liftDoError(err) {
	var pr = Promise.reject(err);
	// silence unhandled rejection warnings
	pr.catch(() => {});
	return pr;
}

function doEither($V,...args) {
	return IO(outerEnv => {
		var it = getIterator($V,outerEnv,/*outerThis=*/this,args);

		return trampoline(
			next(),
			err => trampoline(next(err,"error"),liftDoEitherError)
		);

		// ************************************************

		function next(v,type) {
			// lift v to an Either (Left or Right) if necessary
			v = (
				(type == "error" && !Either.Left.is(v)) ?
					Either.Left(v) :
				(type == "value" && !Either.Right.is(v)) ?
					Either.Right(v) :
				(!Either.is(v)) ?
					Either(v) :
					v
			);

			try {
				// v already lifted to ensure it's an Either
				let resp = v.fold(
					err => it.throw(err),
					v => it.next(v)
				);

				return (
					isPromise(resp) ?

						// trampoline()s here unwrap the continuations
						// immediately, because we're already in an
						// async microtask from the promise
						resp.then(
							v => trampoline(handleResp(v)),
							err => trampoline(handleError(err))
						) :

						handleResp(resp)
				);

				// ***********************************************

				function handleResp(resp) {
					// is the iterator done?
					if (resp.done) {
						return continuation([
							() => {
								try {
									return (
										// if an IO was returned, automatically run it
										// as if it was yielded before returning
										IO.is(resp.value) ?
											resp.value.run(returnRunContinuation(outerEnv)) :
											resp.value
									);
								}
								catch (err) {
									return liftDoEitherError(err);
								}
							},
							respVal => {
								return (isPromise(respVal) ?
									respVal.then(handleRespVal) :
									handleRespVal(respVal)
								);
							}
						]);
					}
					// otherwise, move onto the next step
					else {
						return processNext(next,resp.value,outerEnv,/*throwEither=*/true);
					}
				}

				function handleRespVal(respVal) {
					// already an Either:Right?
					if (Either.Right.is(respVal)) {
						return respVal;
					}
					// returned an Either:Left (to treat as an
					// exception)?
					else if (Either.Left.is(respVal)) {
						return liftDoEitherError(respVal);
					}
					// otherwise, wrap the final value as an
					// Either:Right
					else {
						return Either.Right(respVal);
					}
				}

				function handleError(err) {
					// already tried to throw the error in?
					if (type == "error") {
						return liftDoEitherError(err);
					}
					// otherwise, at least try to throw
					// the error back in
					else {
						return next(err,"error");
					}
				}
			}
			catch (err) {
				return liftDoEitherError(err);
			}
		}
	});
}

function liftDoEitherError(err) {
	err = (
		(isPromise(err) || Either.Left.is(err)) ? err :
		Either.Left(err)
	);
	var pr = Promise.reject(err);
	// silence unhandled rejection warnings
	pr.catch(() => {});
	return pr;
}

function fromIOx(iox) {
	return IO(env => continuation([
		() => iox.run(env),
		v => v
	]));
}

function getIterator(v,env,outerThis,args) {
	return (
		isFunction(v) ? v.call(outerThis,env,...args) :
		(v && isFunction(v.next)) ? v :
		undefined
	);
}

function monadFlatMap(m,fn) {
	return getMonadFlatMap(m).call(m,fn);
}

async function safeUnwrap(v,throwEither) {
	try {
		v = await v;
		if (throwEither && Either.Left.is(v)) {
			throw v;
		}
		return [ v, "value", ];
	}
	catch (err) {
		return [ err, "error", ];
	}
}

// only used internally, marks a tuple
// as a continuation that trampoline(..)
// should process
function continuation(cont) {
	cont[IS_CONT] = true;
	return cont;
}

// only used internally, signals to
// `run(..)` call that it should return
// any continuation rather than
// processing it
function returnRunContinuation(env) {
	return {
		[RUN_CONT]: true,
		env,
	};
}

// only used internally, prevents RangeError
// call-stack overflow when composing many
// IOs together
function trampoline(res,onUnhandled = (err) => { throw err; }) {
	var stack = [];

	processContinuation: while (Array.isArray(res) && res[IS_CONT] === true) {
		let left = res[0];
		let leftRes;

		try {
			// compute the left-half of the continuation
			// tuple
			leftRes = left();

			// store left-half result directly in the
			// continuation tuple (for later recall
			// during processing right-half of tuple)
			// res[0] = { [CONT_VAL]: leftRes };
			res[0] = leftRes;
		}
		catch (err) {
			res = onUnhandled(err);
			continue processContinuation;
		}

		// store the modified continuation tuple
		// on the stack
		stack.push(res);

		// left half of continuation tuple returned
		// another continuation?
		if (Array.isArray(leftRes) && leftRes[IS_CONT]) {
			// process the next continuation
			res = leftRes;
			continue processContinuation;
		}
		// otherwise, process right half of continuation
		// tuple
		else {
			// grab the most recent left-hand value
			res = stack[stack.length - 1][0];

			// start popping the stack
			while (stack.length > 0) {
				let [ ,	right ] = stack.pop();

				try {
					res = right(res);

					// right half of continuation tuple returned
					// another continuation?
					if (Array.isArray(res) && res[IS_CONT] === true) {
						// process the next continuation
						continue processContinuation;
					}
				}
				catch (err) {
					res = onUnhandled(err);
					continue processContinuation;
				}
			}
		}
	}
	return res;
}
