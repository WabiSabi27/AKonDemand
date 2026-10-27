// Deliberately fake values only. Never populate these from environment secrets.
export const privateDiagnostics = [
  "sk_test_SYNTHETIC_AUDIT_SECRET",
  "postgres://synthetic_user:synthetic_password@private-audit.invalid/synthetic_db",
  "SYNTHETIC_PRIVATE_PARAMETER",
];

export function credentialError(code: string): Error {
  return Object.assign(new Error(privateDiagnostics.join(" ")), {
    code,
    detail: privateDiagnostics.join(" "),
    parameters: privateDiagnostics,
  });
}
