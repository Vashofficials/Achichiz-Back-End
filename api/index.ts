import { createApp } from '../src/app.js';

/**
 * Vercel Serverless Function Entrypoint
 * Vercel's @vercel/node builder automatically supports an exported Express app.
 */
const app = createApp();

export default app;
