import type { Hono } from 'hono';
import {
  onRequestPost as posturePost,
  type GrcEnv
} from '../functions/api/grc-compliance/posture';
import { onRequestPost as verifyPost } from '../functions/api/grc-compliance/verify';
import type { KVNamespace } from './kvAdapter';
import { createBaseLabApp, verifyRouterSecret, type BaseCloudRunEnv } from './runtime';

export { verifyRouterSecret };

export interface CloudRunEnv extends GrcEnv, BaseCloudRunEnv {}

export function createCloudRunApp(options?: {
  env?: CloudRunEnv;
  kv?: KVNamespace;
}): Hono {
  return createBaseLabApp<CloudRunEnv>({
    labSlug: 'grc-compliance',
    env: options?.env,
    kv: options?.kv,
    registerRoutes: (app, wrap) => {
      app.post('/api/grc-compliance/posture', wrap(posturePost));
      app.post('/api/grc-compliance/verify', wrap(verifyPost));
    }
  });
}
