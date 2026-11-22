import {createScheduledHandler} from '../_shared/edge-jobs-handler.js';

Deno.serve(createScheduledHandler(undefined, undefined, undefined, {standalone: true}));
