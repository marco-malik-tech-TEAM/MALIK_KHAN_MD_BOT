# Deploy on Railway (GitHub -> Railway -> pairing website)

## 1) Upload to GitHub
1. github.com -> New repository (Private) -> create.
2. Upload ALL files of this folder (drag & drop works). `.gitignore` already keeps secrets/sessions out.

## 2) Deploy on Railway
1. railway.com -> New Project -> Deploy from GitHub repo -> choose your repo.
2. Service -> Settings -> Networking -> **Generate Domain**. That domain is your pairing website.
3. (Recommended) Service -> Volumes -> New Volume, Mount path `/data`.
   Then Variables: `DATA_DIR` = `/data`  (keeps your WhatsApp login after redeploys).
   No Volume? Use `SESSION_ID` instead (step 5).
4. Optional Variables: `WEB_PASSWORD`, `OWNER_NUMBER`, `BOT_PREFIX`.

## 3) Pair
1. Open `https://YOUR-DOMAIN.up.railway.app`
2. Enter your number with country code (e.g. 923001234567) -> **Get Pairing Code**.
3. WhatsApp -> Settings -> Linked Devices -> Link a Device -> *Link with phone number instead* -> enter the code.
4. The page turns green, the bot starts, send `.menu` in WhatsApp.

## 4) Downloads
`.video`, `.ig`, `.apk` - see README_DOWNLOADS.md.

## 5) Keep the login (no Volume)
After linking, the bot sends a message to your own WhatsApp chat containing `SESSION_ID`.
Copy it into Railway -> Variables -> `SESSION_ID`. Never share it.
