# Screenshots

Place deployment evidence here before final submission (referenced in `DEPLOYMENT.md` section 9):

| Filename | What to capture |
|---|---|
| `running-application.png` | `curl https://api.yourdomain.com/health` returning `200 {"status":"ok"}` |
| `pm2-processes.png` | Output of `pm2 status` (Path B) showing `property-api` (cluster, N instances) and `property-worker` both `online` |
| `docker-containers.png` | Output of `docker compose ps` showing `api`, `worker`, `mysql`, `redis` all `Up (healthy)` |
| `https-enabled.png` | Browser address bar padlock on `https://api.yourdomain.com`, or `curl -vI https://api.yourdomain.com/health` showing a successful TLS handshake |
| `nginx-config.png` | `sudo nginx -t` output showing `syntax is ok` / `test is successful` |

These are intentionally not pre-filled since they require an actual live deployment to capture honestly.
