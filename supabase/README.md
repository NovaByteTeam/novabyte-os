# NovaByte publisher portal deployment

The public catalog remains a GitHub Pages site. Supabase supplies email/password
accounts, private package uploads, owner-specific app lists, the public catalog
for approved community apps, and the server-only review/signing API.

## 1. Connect the static site

Set `supabaseUrl` and `supabaseAnonKey` in `src/publishing-config.js` to the
Supabase project's **Project URL** and **publishable/anon key**. Those two
values are public browser configuration. Never put a service-role key or a
signing private key in `src/`, a GitHub Pages artifact, or browser storage.

The administrator email is fixed to `dirazmuhammad400@gmail.com` in both the
site and Edge Function. Admin authorization is checked again by the server;
hiding the review button in the page is not the security boundary.

## 2. Create the database and buckets

From the repository root, link the Supabase CLI to the intended project and
apply the migration:

```powershell
supabase link --project-ref <project-ref>
supabase db push
```

The migration creates:

- A public-read-only `publisher_catalog_apps` catalog table, named separately
  to avoid collisions with existing project tables.
- Private ownership and submission tables protected by row-level security.
- A private `publisher-submissions` bucket with per-user upload paths.
- A public-read-only `published-packages` bucket. Only the Edge Function's
  service role can write published packages.

Do not weaken the RLS policies or expose the private submission bucket.

## 3. Configure account verification

In Supabase Authentication:

1. Enable email/password sign-up and **Confirm email**.
2. Set the site URL to `https://novabyteteam.github.io/novabyte-os/`.
3. Add that URL and local development URLs such as `http://localhost:4174/` to
   the allowed redirect URLs.
4. Configure a production SMTP provider so verification and account emails
   are delivered reliably.

The portal rejects publishing actions unless Supabase reports the account's
email as confirmed.

## 4. Configure private Edge Function secrets

Deploy the API:

```powershell
supabase functions deploy publisher-api
```

Set these values in the Supabase Dashboard's Edge Function secrets (or with
`supabase secrets set` from a secure terminal):

- `NOVABYTE_SIGNING_PRIVATE_JWK`: the Ed25519 private JWK whose public `x`
  value matches `Id_PakcUqjCM2k3i7mSkQy7LadrM_PwVz9S1ikYAzEY`, the
  `NovaByte Trusted Signing` public key already shipped by the site and OS.
  The function refuses to publish if the key is absent or does not match.
  Do not use the committed development/System key or expose this private key
  in the repository. If the matching trusted private key is unavailable,
  publishing must remain disabled until a deliberate trust-store key rotation
  is planned and deployed to the website and OS.
- `RESEND_API_KEY`: API key for the email provider used for submission and
  review notifications.
- `PUBLISHER_NOTIFICATION_FROM`: a sender address verified with that provider.
- `PUBLIC_CATALOG_URL`: `https://novabyteteam.github.io/novabyte-os/apps.json`.

Supabase supplies `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
`SUPABASE_SERVICE_ROLE_KEY` to Edge Functions. Confirm that the deployed
function has those environment values available; the service-role key must
only exist in the function environment.

## 5. Publish and review behavior

- Publishers sign up with email/password, verify their address, then submit
  listing details and a `.novaapp` package. New releases and updates remain
  private while pending review.
- The reviewer inbox is available only to the verified
  `dirazmuhammad400@gmail.com` account. Other users cannot list, download, or
  change submissions, even if they manually call the Edge Function.
- Approval validates the package ID/version, applies the reviewed listing
  metadata, recalculates SHA-512 file and payload integrity hashes, signs the
  package with the server-side Ed25519 key, and only then adds the release to
  the public catalog.
- Rejection and change requests notify the publisher. Publishers can withdraw
  their own submissions or remove their own published app from the catalog.
- Email notification delivery uses Resend. If its secrets are absent or
  delivery fails, the operation remains visible in the portal and the UI
  reports that the notification did not send.

Before announcing the portal, test a new submission and an update using a
non-production app, verify the package signature from the live site and NBOSP,
and confirm the admin account can review while an ordinary verified account
cannot.
