// Vite `?raw` imports (used to load fixture files without Node typings).
declare module "*?raw" {
  const content: string;
  export default content;
}
