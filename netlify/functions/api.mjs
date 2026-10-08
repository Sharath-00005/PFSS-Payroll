// One Netlify Function serves the whole API under /api/*
import { createApi } from '../lib/core.mjs';
import { createStore } from '../lib/store.mjs';
import { pgAdapter } from '../lib/pg-adapter.mjs';

const handle = createApi({ store: createStore(pgAdapter) });

export default async (req, context) => handle(req, { ip: context.ip });

export const config = { path: '/api/*' };
