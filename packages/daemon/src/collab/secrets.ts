// Axis 3 of the collab threat model (DATA CONFIDENTIALITY) — the one-way leg: once context crosses
// the trust boundary, a consented peer can read it and there is NO claw-back. So the lever is
// MINIMIZE (allowlist-first, never whole-repo) + INFORM (a host-visible manifest of exactly what
// crossed). This file is the second net: a denylist of secret-bearing files + a content scanner that
// REFUSES (aborts the pack build) when a secret would cross — never warns-and-sends.

/** Files that must NEVER leave the host, by name/glob (the deny net under the allowlist). */
const DENY_GLOBS: RegExp[] = [
  /(^|\/)\.env(\.|$)/i, // .env, .env.local, .env.production, …
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)\.(aws|ssh|gnupg)\//i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.|$)/i,
  /\.(pem|key|p12|pfx|keystore)$/i,
  /(^|\/)(secrets?|credentials?)(\.|\/|$)/i,
  /service[-_]?account.*\.json$/i,
];

/** High-signal secret SHAPES scanned in any file that would otherwise be sent. */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9]{20,}\b/, // OpenAI-style
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/, // Anthropic-style
  /\bghp_[A-Za-z0-9]{30,}\b/, // GitHub PAT
  /\bgho_[A-Za-z0-9]{30,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT
];

/** True iff the path is a known secret-bearing file (deny net). */
export function isDeniedPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/');
  return DENY_GLOBS.some((g) => g.test(p));
}

/** The secret shapes found in `content` (empty ⇒ clean). */
export function scanSecrets(content: string): string[] {
  const hits: string[] = [];
  for (const re of SECRET_PATTERNS) {
    const m = content.match(re);
    if (m) hits.push(m[0].slice(0, 6)); // a redacted hint, never the full secret
  }
  return hits;
}

export class SecretLeakError extends Error {
  constructor(
    public readonly file: string,
    public readonly hints: string[],
  ) {
    super(
      `refusing to share context: secret detected in ${file} (${hints.join(', ')}…) — aborting`,
    );
    this.name = 'SecretLeakError';
  }
}
