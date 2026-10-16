import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "./storage";

// Refresh tokens live in the Windows Credential Manager. Access tokens are kept in
// memory only and re-created from the refresh token after a restart.
export const VAULT_FIELDS = {
  gmailRefreshToken: "gmail_refresh_token",
  outlookRefreshToken: "outlook_refresh_token",
} as const;

export type VaultField = keyof typeof VAULT_FIELDS;

export async function saveVaultToken(field: VaultField, value: string): Promise<void> {
  if (value) await invoke("secret_set", { key: VAULT_FIELDS[field], value });
  else await invoke("secret_delete", { key: VAULT_FIELDS[field] });
}

// Loads tokens from the vault. Tokens found in old plaintext settings are moved into
// the vault first, so nothing is lost when plaintext storage is switched off.
export async function hydrateVaultTokens(settings: Settings): Promise<Partial<Settings>> {
  const patch: Partial<Settings> = {};
  for (const field of Object.keys(VAULT_FIELDS) as VaultField[]) {
    const legacy = settings[field];
    if (legacy) {
      await saveVaultToken(field, legacy);
    } else {
      const stored = await invoke<string>("secret_get", { key: VAULT_FIELDS[field] });
      if (stored) patch[field] = stored;
    }
  }
  return patch;
}
