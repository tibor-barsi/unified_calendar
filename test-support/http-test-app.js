import express from 'express';
import { registerWidgetRoutes } from '../src/widget-routes.js';

// Boots a bare express app with only the widget routes registered, on an OS-assigned port.
export async function startWidgetTestApp(deps) {
  const app = express();
  registerWidgetRoutes(app, deps);
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
