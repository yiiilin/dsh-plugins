//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@yiln-dsh/dsh-plugin-llm-adapter`.
*
* This package serves the routes the shipped `@deepseek-ai/dsh-llm-pi-ai` row
* would serve (that row is disabled by this package's bundle patch), but it is
* a distinct installed package, so it reserves its own name rather than the
* upstream one. Reserving the upstream name here would claim ownership of a
* package this fork does not install.
* @module @yiln-dsh/dsh-plugin-llm-adapter/invariant
*/
const PACKAGE_NAME = "@yiln-dsh/dsh-plugin-llm-adapter";
/** Cordis companion plugin name. */
const name = "llm-pi-ai-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: this package exposes no independent event sequence or mutable data relation
* beyond contracts enforced at its owning seam.
*/
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
