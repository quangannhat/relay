import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

export const relaySocketPath = (databasePath = process.env.RELAY_DB ?? "relay.db") =>
  process.env.RELAY_SOCKET ??
  join(
    process.env.XDG_RUNTIME_DIR ?? tmpdir(),
    `relay-${process.getuid?.() ?? "user"}-${createHash("sha256")
      .update(resolve(databasePath))
      .digest("hex")
      .slice(0, 16)}.sock`
  )
