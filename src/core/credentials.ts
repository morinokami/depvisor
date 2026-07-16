import { localConfigEntries } from "./git.ts";

/**
 * Best-effort detection of git credentials persisted in the target checkout.
 *
 * Token separation is structural on depvisor's side, but the user's workflow
 * can defeat it before depvisor starts: actions/checkout defaults to
 * `persist-credentials: true`, which leaves the token in `.git/config` where
 * the agent step and the target's install scripts can read it. This checks
 * the known common vectors — it is a misconfiguration gate, not a guarantee
 * that no credential exists anywhere.
 *
 * Findings name only config keys, never values — and URL-bearing subsections
 * are redacted from the keys, because a subsection like
 * `http.https://<token>@host/.extraheader` carries the secret itself.
 */
export function detectPersistedCredentials(repo: string): string[] {
  const findings: string[] = [];

  // actions/checkout persist-credentials stores the token as
  // `http.<server>/.extraheader = AUTHORIZATION: basic <base64>`; the
  // unscoped `http.extraheader` applies to every HTTP request and can
  // persist a token just the same.
  for (const { key, value } of localConfigEntries(repo, "^http(\\..*)?\\.extraheader$")) {
    if (/^\s*(proxy-)?authorization\s*:/i.test(value)) {
      findings.push(`${redactSubsection(key)} carries an Authorization header`);
    }
  }

  // Tokens embedded in a remote URL, either as the username
  // (https://<token>@github.com/…) or as x-access-token:<token>. pushurl is
  // its own key: a clean fetch URL can still hide a credentialed push URL.
  // The subsection is the remote NAME, not a URL, so the key stays readable.
  for (const { key, value } of localConfigEntries(repo, "^remote\\..*\\.(url|pushurl)$")) {
    if (httpUrlHasUserinfo(value)) {
      findings.push(`${key} embeds credentials in the remote URL`);
    }
  }

  // url.<base>.insteadOf rewrites (the common private-registry token setup)
  // carry the credentialed URL in the key's subsection — the value only holds
  // the prefix being replaced.
  for (const { key } of localConfigEntries(repo, "^url\\..*\\.(insteadof|pushinsteadof)$")) {
    const base = subsectionOf(key);
    if (base !== null && httpUrlHasUserinfo(base)) {
      findings.push(`${redactSubsection(key)} rewrites remote URLs to one embedding credentials`);
    }
  }

  // actions/checkout with an `ssh-key` input persists the key by pointing
  // core.sshCommand at a written-out key file.
  for (const { key } of localConfigEntries(repo, "^core\\.sshcommand$")) {
    findings.push(`${key} is set (persisted SSH key)`);
  }

  // A repo-local credential helper means any process in this checkout can
  // authenticate as the stored identity. Helpers belong in global/system
  // config on developer machines; repo-local ones are persisted-credential
  // setups.
  for (const { key } of localConfigEntries(repo, "^credential\\.(.*\\.)?helper$")) {
    findings.push(`${redactSubsection(key)} is set (repo-local credential helper)`);
  }

  return findings;
}

// Config keys are section.subsection.variable; sections and variables cannot
// contain dots, so the subsection spans the first to the last dot. Subsections
// CAN be full URLs — userinfo included — which is why findings redact them.

function subsectionOf(key: string): string | null {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first === -1 || last === first) return null;
  return key.slice(first + 1, last);
}

function redactSubsection(key: string): string {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first === -1 || last === first) return key; // no subsection, nothing secret-bearing
  return `${key.slice(0, first)}.<redacted>${key.slice(last)}`;
}

function httpUrlHasUserinfo(raw: string): boolean {
  const url = URL.parse(raw);
  if (!url) return false; // scp-style ssh or a local path — not an http URL with userinfo
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.username !== "" || url.password !== "";
}

/** Message for the check-credentials action step's ::error output. */
export function persistedCredentialsSummary(findings: string[]): string {
  return (
    `The target checkout carries persisted git credentials (${findings.join("; ")}). ` +
    "depvisor keeps tokens away from the agent step and the target's install scripts, " +
    "so it refuses to run next to one. In GitHub Actions, set " +
    "`persist-credentials: false` on actions/checkout and pass a token only via the " +
    "github_token input; locally, remove the credential entries from the repo-local " +
    "git config."
  );
}
