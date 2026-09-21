// Normalize the only repository identity accepted by sandbox host policy.

export function canonicalRepositoryIdentity(remote) {
  if (typeof remote !== "string" || remote.includes("\0")) throw new Error("repository remote is invalid");
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote);
  if (!match) throw new Error("repository remote is not a supported GitHub identity");
  return `${match[1]}/${match[2]}`.toLowerCase();
}
