export const payerStates=new Set(['pending','gateway_accepted','sent','delivered','failed','unknown','suppressed','expired']);
export const payerReasons=new Set(['historical','preferences_disabled','unverified_destination','reversed','ineligible','authority_changed',
  'before_activation','prior_posting','window_elapsed','claim_suppressed','gateway_failed','gateway_expired','gateway_cancelled','gateway_unconfirmed']);
