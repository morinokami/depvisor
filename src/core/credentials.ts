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
 * Findings name only config keys, never values: the values are the secrets.
 */
export function detectPersistedCredentials(repo: string): string[] {
  const findings: string[] = [];

  // actions/checkout persist-credentials stores the token as
  // `http.<server>/.extraheader = AUTHORIZATION: basic <base64>`; the
  // unscoped `http.extraheader` applies to every HTTP request and can
  // persist a token just the same.
  for (const { key, value } of localConfigEntries(repo, "^http(\\..*)?\\.extraheader$")) {
    if (/^\s*(proxy-)?authorization\s*:/i.test(value)) {
      findings.push(`${key} carries an Authorization header`);
    }
  }

  // Tokens embedded in a remote URL, either as the username
  // (https://<token>@github.com/…) or as x-access-token:<token>.
  for (const { key, value } of localConfigEntries(repo, "^remote\\..*\\.url$")) {
    if (httpUrlHasUserinfo(value)) {
      findings.push(`${key} embeds credentials in the remote URL`);
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
    findings.push(`${key} is set (repo-local credential helper)`);
  }

  return findings;
}

function httpUrlHasUserinfo(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false; // scp-style ssh or a local path — not an http URL with userinfo
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.username !== "" || url.password !== "";
}

/** One message for both surfaces: the action step's ::error and the preflight summary. */
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
