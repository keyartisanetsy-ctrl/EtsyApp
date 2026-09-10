# Using the app from two computers

The app is local-first by design: one server, one SQLite file, bound to
`127.0.0.1` so nothing outside the machine can reach it. If you want the
same shop data open on two different computers (e.g. a home PC and a VDS,
on different networks), the simplest and safest option is **not** to run
two independent copies and sync them — that means two SQLite files that can
drift apart and would need real conflict resolution. Instead, run the app
**once**, on the machine that's on all the time (the VDS), and have every
computer just open it in a browser. One database, always consistent,
nothing to keep in sync.

## The fast path: one script

`deploy/setup-vds.sh` does everything below in one run -- installs Node if
missing, installs and builds the app, generates a random app password,
installs Caddy with automatic HTTPS (using a free `nip.io` hostname that
maps straight back to your VDS's IP, so no domain purchase or DNS step is
needed), and installs a systemd service so it survives reboots.

SSH into the VDS, then:

```bash
git clone <this repo> EtsyApp
cd EtsyApp
bash deploy/setup-vds.sh <VDS_PUBLIC_IP>
```

It prints the URL and the generated password at the end -- write both down.
Safe to re-run later to pick up new code: it reuses what is already
installed and just rebuilds the app.

**On a Windows Server VDS**, use `deploy/setup-vds.ps1` instead -- it does
the exact same thing with Windows-native tools (an MSI install of Node, a
plain zip download of the app so no Git installation is needed, Caddy and
the app registered as real Windows services via NSSM so both restart on
reboot). Open PowerShell **as Administrator** on the VDS, then:

```powershell
irm https://raw.githubusercontent.com/keyartisanetsy-ctrl/EtsyApp/claude/etsy-bulk-management-app-q3enu5/deploy/setup-vds.ps1 -OutFile setup-vds.ps1
powershell -ExecutionPolicy Bypass -File .\setup-vds.ps1 -PublicIP <VDS_PUBLIC_IP>
```

The `-ExecutionPolicy Bypass` only applies to this one run; it does not
change anything system-wide. Check the services any time with
`Get-Service EtsyCommandCenter, EtsyCaddy`.

The rest of this document explains the same steps by hand, for anyone who
wants to customize something the script assumes (a real domain instead of
`nip.io`, a non-Debian VDS, an existing Caddy/systemd setup, etc).

## 1. Get the app onto the VDS

```bash
git clone <this repo> EtsyApp
cd EtsyApp
npm run setup     # npm install + codegen
npm run build     # builds web/dist so the server can serve it
```

## 2. Configure it for remote use

Copy `.env.example` to `.env` and set:

```bash
HOST=127.0.0.1          # keep this at loopback -- see step 3, do not set 0.0.0.0
APP_PASSWORD=<a long random password>
ETSY_REDIRECT_URI=http://localhost:4317/api/auth/callback   # unchanged; see note below
```

`APP_PASSWORD` is the existing gate in `server/src/index.js` — once it's
set, every `/api` route requires either an `x-app-password` header or the
`app_password` cookie the login screen sets. Nothing new to build; it was
already there for exactly this case (see the comment on `security.appPassword`
in `server/src/config.js`: *"Local-first tool: bind to loopback. Set an app
password to expose it."*). Pick a real password — this is the only thing
standing between the public internet and your Etsy shop data once you do
step 3.

**Do not set `HOST=0.0.0.0`.** Put a reverse proxy in front instead (step 3)
so the app itself is only ever reachable via loopback, and the only thing
exposed to the internet is the proxy, over HTTPS.

## 3. Put HTTPS in front of it

Etsy's OAuth dashboard refuses raw IP addresses as a redirect URI, so you
need a hostname regardless. Point any DNS name you control at the VDS's IP,
then use [Caddy](https://caddyserver.com/) — it fetches and renews the
certificate itself, no manual Let's Encrypt steps:

```bash
sudo apt install caddy   # or see caddyserver.com/docs/install
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
# edit the hostname inside, then:
sudo systemctl reload caddy
```

You do not need to change `ETSY_REDIRECT_URI` or re-register anything with
Etsy for this. The redirect URI is only used during the one-time "connect
shop" OAuth flow; after that, tokens refresh themselves. If you ever need
to reconnect the shop, do it once from the VDS itself (`http://localhost:4317`
via SSH port-forward, or a temporary second redirect URI added in Etsy's
dashboard) — day-to-day use never touches it.

## 4. Keep it running

```bash
sudo cp deploy/etsy-command-center.service.example /etc/systemd/system/etsy-command-center.service
# fill in the CHANGE_ME placeholders, then:
sudo systemctl daemon-reload
sudo systemctl enable --now etsy-command-center
```

## 5. Use it from both computers

Open `https://<your-hostname>` from either PC's browser. First visit asks
for the app password; the cookie then lasts `SESSION_TTL_HOURS` (30 days by
default). Both machines are now looking at the same live server and the
same database — a change made on one shows up on the other on next refresh,
with no sync step and no risk of the two drifting apart.

## Extra hardening (optional)

- Firewall the VDS so only ports 443 (Caddy) and 22 (SSH) are open; never
  open the app's own port (4317) to the internet — it should only ever be
  reached via `127.0.0.1` from Caddy.
- If both computers have static IPs, restrict 443 to just those IPs at the
  firewall level instead of leaving it open to everyone.
- For the tightest setup, skip public exposure entirely and put both
  computers and the VDS on a private mesh network (e.g.
  [Tailscale](https://tailscale.com/)) — then nothing is internet-facing at
  all, and `APP_PASSWORD` becomes a second layer rather than the only one.
