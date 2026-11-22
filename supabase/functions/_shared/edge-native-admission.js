export function requireNativeAdmission(admitted) {
  if (!(admitted?.request instanceof Request) || typeof admitted.networkBucket !== 'function') {
    throw new Error('native_ingress_unconfigured');
  }
  return admitted;
}

// Direct admission already owns its request and network bucket. Signed ingress
// releases them only after the HTTP handler claims the nonce inside its fence.
export async function prepareNativeIngress(request, env, {
  admitDirectSupabaseNativeIngress, verifyNativeIngress, claimNativeIngress, consumeNativeIngressNonce,
}) {
  if (env.BURIMUNSI_NATIVE_ENABLED !== 'true') throw new Error('native_ingress_unconfigured');

  const mode = env.COLLECT_NATIVE_INGRESS_MODE;
  if (mode === 'supabase_direct_v1') {
    if (typeof admitDirectSupabaseNativeIngress !== 'function') {
      throw new Error('native_ingress_unconfigured');
    }
    const admitted = requireNativeAdmission(await admitDirectSupabaseNativeIngress(request, env));
    return {request: admitted.request, networkBucket: admitted.networkBucket};
  }

  if (![undefined, '', 'signed_frontdoor_v1'].includes(mode) ||
      typeof verifyNativeIngress !== 'function' ||
      typeof claimNativeIngress !== 'function' ||
      typeof consumeNativeIngressNonce !== 'function') {
    throw new Error('native_ingress_unconfigured');
  }
  const pendingClaim = await verifyNativeIngress(request, env);
  if (!pendingClaim || typeof pendingClaim !== 'object') throw new Error('native_ingress_unconfigured');
  return {request, pendingClaim};
}
