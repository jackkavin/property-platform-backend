# Deployment Guide — Ubuntu VPS (DigitalOcean)

Two deployment paths are documented: **A) Docker Compose** (recommended — everything, including MySQL/Redis, isolated and reproducible) and **B) Bare PM2** (if you want DB/Redis installed directly on the host). Both sit behind Nginx with Let's Encrypt.

---

## 0. Provision the VPS

1. Create an Ubuntu 22.04 LTS droplet (2 vCPU / 4GB RAM minimum for comfortable headroom).
2. Point a DNS `A` record for `api.yourdomain.com` at the droplet's IP.
3. SSH in as root once, then immediately create a non-root deploy user — **never run the app or deploy as root**:

```bash
adduser deployer
usermod -aG sudo deployer
rsync --archive --chown=deployer:deployer ~/.ssh /home/deployer
su - deployer
```

## 1. Firewall (UFW)

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

Note: **do not** open 3000 (app), 3306 (MySQL), or 6379 (Redis) to the public internet. Only Nginx (80/443) and SSH are exposed; the app talks to MySQL/Redis over localhost or the Docker internal network.

## 2. Install base tooling

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git unzip nginx certbot python3-certbot-nginx

# Docker (Path A)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker deployer
newgrp docker

# Node.js 18 + PM2 (Path B, or needed either way for `npm run migrate` locally)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

## 3. Get the code onto the server

```bash
cd /home/deployer
git clone <your-repo-url> property-platform-backend
cd property-platform-backend
cp .env.example .env
nano .env   # fill in real DB/Redis passwords, CRM_WEBHOOK_SECRET, WPGRAPHQL_ENDPOINT, CORS_ALLOWED_ORIGINS
chmod 600 .env
```

Generate strong secrets rather than hand-typing them:
```bash
openssl rand -hex 32   # use for CRM_WEBHOOK_SECRET
openssl rand -hex 24   # use for DB_PASSWORD / REDIS_PASSWORD
```

---

## Path A — Docker Compose (recommended)

```bash
docker compose build
docker compose up -d
docker compose ps                 # confirm api, worker, mysql, redis all "healthy"
docker compose logs -f api        # watch startup logs
```

Migrations run automatically on first MySQL boot via the mounted `migrations/` init directory. To (re)run manually:
```bash
docker compose exec api node dist/scripts/migrate.js
```

Update / redeploy:
```bash
git pull
docker compose build api worker
docker compose up -d --no-deps api worker
```

## Path B — Bare PM2 (MySQL/Redis installed on host)

```bash
sudo apt install -y mysql-server redis-server
sudo mysql_secure_installation
# create DB user matching your .env values:
sudo mysql -e "CREATE USER 'property_app'@'localhost' IDENTIFIED BY 'your_password'; \
  CREATE DATABASE property_platform CHARACTER SET utf8mb4; \
  GRANT ALL PRIVILEGES ON property_platform.* TO 'property_app'@'localhost'; FLUSH PRIVILEGES;"

# Require a password on Redis (edit /etc/redis/redis.conf -> requirepass <value>), then:
sudo systemctl restart redis-server

npm install
npm run build
npm run migrate

pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup systemd   # run the command it prints, so PM2 survives a reboot
```

Common PM2 operations:
```bash
pm2 status
pm2 logs property-api
pm2 reload property-api   # zero-downtime reload (cluster mode)
pm2 monit
```

---

## 4. Nginx reverse proxy + HTTPS

```bash
sudo cp nginx/nginx.conf /etc/nginx/sites-available/property-platform
sudo cp nginx/proxy_params_property.conf /etc/nginx/proxy_params_property.conf
sudo sed -i 's/api.yourdomain.com/YOUR_REAL_DOMAIN/' /etc/nginx/sites-available/property-platform
sudo ln -s /etc/nginx/sites-available/property-platform /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx

# Issue the certificate (certbot edits the config to add ssl_certificate lines
# and sets up auto-renewal via a systemd timer)
sudo certbot --nginx -d api.yourdomain.com --redirect --agree-tos -m you@yourdomain.com

# Confirm auto-renewal works
sudo certbot renew --dry-run
```

## 5. Verify

```bash
curl -i https://api.yourdomain.com/health
curl -i https://api.yourdomain.com/health/ready
curl -i -X POST https://api.yourdomain.com/api/enquiry \
  -H "Content-Type: application/json" \
  -d '{"fullName":"Test User","email":"test@example.com","propertyId":1,"message":"Interested in this property"}'
```

## 6. Logging strategy

- **App logs**: structured JSON via Winston. Docker path → `docker compose logs`; PM2 path → `logs/*.log` + `pm2 logs`.
- **Nginx logs**: `/var/log/nginx/property-platform.{access,error}.log`.
- **Log rotation**: `pm2 install pm2-logrotate` (Path B) or configure the Docker `json-file` log driver with `max-size`/`max-file` (Path A) to prevent disk exhaustion.
- **Audit trail**: every inbound CRM webhook call, valid or not, is persisted to the `crm_webhook_events` table — this is your source of truth during an incident, independent of ephemeral log files.

## 7. Environment variable management

- `.env` is **never committed** (see `.gitignore`) and is `chmod 600`, owned by `deployer`.
- Secrets (`DB_PASSWORD`, `REDIS_PASSWORD`, `CRM_WEBHOOK_SECRET`) are generated per-environment, not reused between staging/production.
- `src/config/env.ts` validates every variable at boot with Zod — a missing/malformed value fails deployment immediately instead of causing a subtle runtime bug.
- For a team setup beyond a single VPS, migrate secrets into a proper secrets manager (Doppler, Vault, or the cloud provider's native secrets store) rather than a flat file.

## 8. Health check endpoint

- `GET /health` — liveness only (process is running). Used by Docker `HEALTHCHECK` and PM2 restart-on-crash.
- `GET /health/ready` — readiness (DB + Redis reachable). Point Nginx or an external uptime monitor (e.g. UptimeRobot, Better Stack) at this one, since a process that's "alive" but can't reach its DB should still be treated as down.

## 9. Screenshots checklist (for submission)

Capture and place in `screenshots/`:
- `running-application.png` — `curl https://.../health` returning 200
- `pm2-processes.png` — output of `pm2 status` (Path B) or `docker compose ps` (Path A)
- `docker-containers.png` — `docker compose ps` / `docker ps` showing api, worker, mysql, redis all `Up (healthy)`
- `https-enabled.png` — browser padlock / `curl -vI` showing TLS handshake succeeding
- `nginx-config.png` — `sudo nginx -t` showing `syntax is ok` / `test is successful`
