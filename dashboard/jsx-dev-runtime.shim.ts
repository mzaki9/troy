// React 19's production build of react/jsx-dev-runtime intentionally exports
// jsxDEV as undefined — it is a dev-only API. Bun's JSX transform, however,
// always imports jsxDEV (even with NODE_ENV=production), which made the bundled
// dashboard throw "O is not a function" at module start. This shim redirects
// those imports to react/jsx-runtime, whose jsx works in both dev and prod.
export { Fragment, jsx, jsx as jsxDEV, jsxs } from "react/jsx-runtime";
