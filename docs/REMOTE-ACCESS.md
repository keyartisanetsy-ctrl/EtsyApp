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
the same job with Windows-native tools (an MSI install of Node, a plain zip
download of the app so no Git installation is needed, the app and a
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
both registered as real Windows services via NSSM so they restart on
reboot). Open PowerShell **as Administrator** on the VDS, then:

```powershell
irm https://raw.githubusercontent.com/keyartisanetsy-ctrl/EtsyApp/claude/etsy-bulk-management-app-q3enu5/deploy/setup-vds.ps1 -OutFile setup-vds.ps1
powershell -ExecutionPolicy Bypass -File .\setup-vds.ps1
```

No public IP to pass in and no inbound port to open, on Windows or at the
VDS provider's own level: `cloudflared` makes only an *outbound* connection
to Cloudflare, which hands back a public `https://<random-words>.trycloudflare.com`
address (printed at the end, along with the password). That address changes
every time the tunnel service restarts -- check the log
(`C:\EtsyAppTools\logs\EtsyTunnel-err.log`) if it stops responding.

The `-ExecutionPolicy Bypass` only applies to this one run; it does not
change anything system-wide. Check the services any time with
`Get-Service EtsyCommandCenter, EtsyTunnel`.

**You should not need to run this script again after this.** Both
`AUTO_UPDATE` and `AUTO_UPDATE_RESTART` are on by default now (this script
still sets them explicitly, which is redundant but harmless) -- from here on
the app checks its own branch the moment it starts, and every 30 minutes
after, updating and restarting itself on its own when a fix ships; safe here
because `EtsyCommandCenter` is an NSSM service that restarts itself on exit.
Re-run this script by hand only if something about the VDS itself changes (a
fresh machine, Node got uninstalled, etc.), not to pick up an app update.

(The Linux script still uses Caddy with your own IP/hostname and needs
inbound 80/443 open, at the OS and at whatever sits in front of the VDS. If
that is not something you can open -- some providers don't give you access
to their side of it at all -- `cloudflared` works the same way on Linux:
`cloudflared tunnel --url http://127.0.0.1:4317` needs nothing inbound
either.)

## Even faster: a public link from your own one-click start

If you just want to open the copy of the app already running on your own
PC from somewhere else — no VDS at all — set one line in `.env`:

```
REMOTE_ACCESS=1
```

The next time you run `npm start` (or double-click the packaged app), it
opens a tunnel to itself via [Pinggy](https://pinggy.io) — no binary to
download, just an outbound SSH connection — and prints a box like:

```
======================================================================
  Open from anywhere:  https://some-random-words.free.pinggy.link
  Password:            a9F3kLp2Qz...
======================================================================
```

`APP_PASSWORD` is generated automatically the first time this runs if you
had not already set one. That link works from any browser, anywhere.

**It renews itself automatically.** Pinggy's free tier closes the
connection on its own after about an hour — this notices right away and
opens a fresh one with a new address, printed in the same terminal window
again, for as long as `npm start` keeps running. Nothing to re-run by hand;
just keep an eye on this window for the next address once it renews. Closing
the window (or restarting the app) ends the link the same as before — the
next start opens a new one.

Needs an `ssh` command on this machine — Windows 10/11 already include one
(OpenSSH Client, on by default since 2018); if it's genuinely missing, the
app says so and keeps running locally, no public link. Prefer the old
Cloudflare Tunnel path instead (a small binary is downloaded once, but its
link does not renew itself while the app stays open — closing that gap is
the whole point of Pinggy being the default now)? Set `TUNNEL_PROVIDER=cloudflare`
in `.env` alongside `REMOTE_ACCESS=1`.

**This changes nothing about what Etsy sees.** Every Etsy API call this app
makes happens from wherever this process is physically running — a browser
opening the link from a different city, network or device never talks to
Etsy directly, so no other location's IP ever reaches Etsy. Only the
computer you pressed "start" on does.

## Connecting an additional Etsy shop

Two things trip people up here, and neither is about IP addresses:

- **"Connect another shop" just re-shows the shop I already have.** Etsy
  is re-approving whichever Etsy.com account your browser is already
  signed into — it never had to ask you to log in again. Log out of
  Etsy.com in that browser (or open a private/incognito window), then
  press the button again; Etsy will prompt a fresh login, and whichever
  account you sign in as is the shop that gets connected.
- **Connecting a shop through a remote link does not complete.** The
  one-time OAuth handshake ends with Etsy sending your browser back to
  this app's own callback address (`ETSY_REDIRECT_URI`, normally
  `http://localhost:4317/api/auth/callback`). That only resolves to
  *this* app if the browser doing the connecting is on the same machine
  the app is running on — "localhost" always means "wherever I am", not
  a specific server. Browsing everything else (listings, orders, SKUs...)
  through a public/tunnel link works from anywhere; do the one-time
  "connect a shop" step directly on the computer or VDS the app itself
  runs on (its own screen, or an RDP/SSH session into it), not through
  the tunnel link from a different device.

  `localhost` is not tied to any one computer, so once
  `http://localhost:4317/api/auth/callback` is registered as your Etsy
  app's callback URL, that same registration keeps working forever, on
  any machine you ever run this app on — moving to a new VDS or a new PC
  never requires touching Etsy's side of it again. (Etsy's own app
  dashboard also outright rejects an IP-literal callback URL like
  `http://127.0.0.1:4317/...` — always use `localhost`.)

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
