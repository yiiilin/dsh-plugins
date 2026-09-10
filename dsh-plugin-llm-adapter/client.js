/*
 * Model-level service-tier and reasoning controls are injected into the
 * official Settings Models editor by the Host-side bundle patch. The client
 * half stays intentionally empty so no provider-specific card is rendered.
 */
window.__ModuleLoader__.load({
  id: "@yiln-dsh/dsh-plugin-llm-adapter",
  factory: () => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const inject = [];
    function apply() {}
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
