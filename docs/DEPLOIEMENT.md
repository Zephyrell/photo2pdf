# Déploiement et configuration

D'un conteneur vide à l'app installée sur l'iPhone.

- [1. Prérequis](#1-prérequis)
- [2. Choisir la méthode](#2-choisir-la-méthode)
- [3. Installation](#3-installation)
- [4. Configuration](#4-configuration)
- [5. Vérifier que ça tourne](#5-vérifier-que-ça-tourne)
- [6. HTTPS](#6-https)
- [7. Installer sur l'iPhone](#7-installer-sur-liphone)
- [8. Mise à jour](#8-mise-à-jour)
- [9. Sauvegarde](#9-sauvegarde)
- [10. Dépannage](#10-dépannage)

## 1. Prérequis

- Un LXC Debian, Ubuntu ou Alpine. **1 vCPU et 128 Mo de RAM suffisent** : tout le
  traitement d'image se fait sur le téléphone.
- `python3` (3.7+). Aucun paquet Python, aucun build.
- Une URL en **HTTPS**. Ce n'est pas du confort : sans HTTPS, Safari refuse d'installer la
  PWA sur l'écran d'accueil et `navigator.share` est peu fiable.

## 2. Choisir la méthode

| Méthode | Prends-la si |
|---|---|
| **Alpine (OpenRC)** | ta LXC est sous Alpine — le plus léger, pas de démon Docker |
| **Debian/Ubuntu (systemd)** | ta LXC est sous Debian ou Ubuntu |
| **Docker** | tu veux le même conteneur sur plusieurs machines |

Les trois donnent exactement le même service, sur le même port.

## 3. Installation

### 3.a Alpine (OpenRC)

```sh
apk add python3 git
git clone https://github.com/Zephyrell/photo2pdf /opt/photo2pdf
adduser -D -H -s /sbin/nologin photo2pdf
mkdir -p /srv/scans && chown photo2pdf:photo2pdf /srv/scans
install -m 755 /opt/photo2pdf/deploy/photo2pdf.openrc /etc/init.d/photo2pdf
install -m 644 /opt/photo2pdf/deploy/photo2pdf.confd /etc/conf.d/photo2pdf
rc-update add photo2pdf default
rc-service photo2pdf start
```

### 3.b Debian / Ubuntu (systemd)

```sh
apt install python3 git
git clone https://github.com/Zephyrell/photo2pdf /opt/photo2pdf
useradd -r -s /usr/sbin/nologin photo2pdf
mkdir -p /srv/scans && chown photo2pdf:photo2pdf /srv/scans
install -m 644 /opt/photo2pdf/deploy/photo2pdf.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now photo2pdf
```

### 3.c Docker

```sh
git clone https://github.com/Zephyrell/photo2pdf /opt/photo2pdf
cd /opt/photo2pdf
mkdir -p scans && sudo chown -R 10001:10001 scans   # l'image tourne sans root
docker compose up -d --build
```

Sur un LXC Proxmox, Docker exige l'imbrication côté hôte :

```sh
pct set <id> --features nesting=1
pct reboot <id>
```

## 4. Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `8000` | port d'écoute |
| `SCAN_DIR` | `./scans` (Docker : `/scans`) | dossier où atterrissent les PDF |
| `AUTH_USERS` | vide | comptes autorisés : `nom:empreinte` séparés par `;` |
| `SESSION_SECRET` | généré | clé de signature des cookies de session |

### Créer un compte

Une ligne par personne, un mot de passe chacune ; seul son empreinte PBKDF2 est stockée.

```sh
python3 /opt/photo2pdf/server.py hash     # demande le mot de passe, affiche l'empreinte
# pbkdf2_sha256$600000$b2c1…$9f3a…
```

Préfixe le résultat par le nom de la personne, puis mets le tout dans `AUTH_USERS` :

```sh
AUTH_USERS='clement:pbkdf2_sha256$…;marie:pbkdf2_sha256$…'
```

Où la poser :

- **Alpine** : `/etc/conf.d/photo2pdf` — entre **apostrophes simples**, l'empreinte contient
  des `$`
- **systemd** : la ligne `Environment=AUTH_USERS=…` de `/etc/systemd/system/photo2pdf.service`
- **Docker** : `AUTH_USERS` dans `docker-compose.yml`, ou un fichier `.env` à côté

Puis redémarrer ; le journal affiche `comptes : clement`. La première visite redirige vers
`/login` ; le cookie signé dure 30 jours et le bouton **Quitter** le supprime. Retirer une
ligne de `AUTH_USERS` invalide immédiatement les sessions de cette personne.

`SESSION_SECRET` ne sert qu'à garder les cookies valides si le dossier `SCAN_DIR` est
recréé (Docker) : sinon une clé aléatoire est écrite dans `SCAN_DIR/.session-secret` au
premier démarrage.

> **Sans `AUTH_USERS`, le service est ouvert** : quiconque atteint l'URL peut déposer,
> lire et supprimer les PDF. Sur un réseau privé, c'est acceptable ; dès que l'URL est
> joignable de l'extérieur, mets des comptes.

`SCAN_DIR` doit appartenir à l'utilisateur du service (`photo2pdf`), sinon l'envoi répond
500.

### Mémo à la connexion

`deploy/motd` rappelle ces commandes à chaque connexion. Pour l'installer sur le LXC :

```sh
install -m 0644 /opt/photo2pdf/deploy/motd /etc/motd
cp /etc/motd /root/MODE-OPERATOIRE.txt     # depuis « pct enter », qui n'affiche pas le motd
```

## 5. Vérifier que ça tourne

Sur la machine elle-même :

```sh
curl -s http://127.0.0.1:8000/login | head -1
# <!doctype html>

curl -sI http://127.0.0.1:8000/manifest.webmanifest | grep -i content-type
# content-type: application/manifest+json     ← si autre chose, l'installation iPhone échouera

curl -s -c /tmp/p2p -o /dev/null -d 'user=clement&password=<mot de passe>' \
     http://127.0.0.1:8000/login
curl -s -b /tmp/p2p http://127.0.0.1:8000/api/scans
# {"ok": true, "files": []}
```

Puis depuis une autre machine, via l'URL HTTPS :

```sh
curl -sI https://scan.example.com/manifest.webmanifest | grep -i content-type
```

## 6. HTTPS

Au choix, du plus simple au plus classique.

**Tailscale** (aucun nom de domaine, HTTPS automatique sur le tailnet) :

```sh
tailscale serve --bg 8000
tailscale serve status      # donne l'URL https://…ts.net
```

**Caddy** (TLS automatique) :

```
scan.example.com {
    reverse_proxy 127.0.0.1:8000
}
```

**nginx** (certificat via certbot) :

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name scan.example.com;

    ssl_certificate     /etc/letsencrypt/live/scan.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/scan.example.com/privkey.pem;

    client_max_body_size 10m;   # sinon l'envoi d'un PDF répond 413

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Avec **nginx-proxy-manager**, rien à ajouter : son `nginx.conf` pose déjà
`client_max_body_size 2000m` globalement. La ligne n'est utile que pour un nginx monté à la
main, dont la limite par défaut est **1 Mo** — un PDF de facture passerait, deux non.

Le serveur écoute sur `0.0.0.0:8000`. Si un reverse proxy tourne sur la même machine,
restreins-le à la boucle locale : `PORT=8000` + pare-feu, ou expose-le seulement au proxy.

## 7. Installer sur l'iPhone

1. **Safari** (pas Chrome — seul Safari peut installer une PWA sur iOS), ouvre
   `https://scan.example.com`.
2. Connecte-toi une fois avec ton nom et ton mot de passe. Le cookie persiste 30 jours,
   y compris pour l'app installée sur l'écran d'accueil.
3. Bouton **Partager** → **Sur l'écran d'accueil** → **Ajouter**.
4. Ouvre l'app depuis l'écran d'accueil : elle prend tout l'écran, sans barre d'adresse.
5. Test complet : **Ajouter une photo** → recadrer les 4 coins → **Créer le PDF** →
   **Partager**, puis **Envoyer sur le serveur** et vérifie que le fichier apparaît dans
   **Historique serveur**.

## 8. Mise à jour

**Alpine / Debian :**

```sh
git -C /opt/photo2pdf pull
rc-service photo2pdf restart      # ou : systemctl restart photo2pdf
```

**Docker :**

```sh
git -C /opt/photo2pdf pull
cd /opt/photo2pdf && docker compose up -d --build
```

Les fichiers `index.html`, `.js` et le manifeste sont relus à chaque requête et servis en
`no-cache` : une mise à jour du front ne demande pas de redémarrage. Seul `server.py` en a
besoin.

Sur l'iPhone, si l'ancienne version persiste, ferme l'app depuis le sélecteur d'apps et
relance-la.

## 9. Sauvegarde

Tout tient dans `SCAN_DIR` — des PDF, rien d'autre. Aucune base de données.

```sh
tar -czf scans-$(date +%F).tar.gz -C /srv scans
```

Restauration : extraire l'archive dans `SCAN_DIR`, puis
`chown -R photo2pdf:photo2pdf /srv/scans`.

## 10. Dépannage

| Symptôme | Cause probable | Correctif |
|---|---|---|
| Pas de « Sur l'écran d'accueil » | URL en HTTP, ou manifeste mal servi | passe en HTTPS ; `curl -I …/manifest.webmanifest` doit donner `application/manifest+json` |
| « Partage impossible » | HTTP au lieu de HTTPS, ou Safari desktop | ouvre l'app depuis l'icône, en HTTPS |
| « Envoi impossible : HTTP 413 » | corps trop gros pour le reverse proxy | `client_max_body_size 10m` |
| « Envoi impossible : HTTP 403 » | chemin protégé (`/scans`) | normal : passe par l'app |
| « Envoi impossible : HTTP 401 » | cookie expiré ou compte retiré | reconnecte-toi, ou remets le compte dans `AUTH_USERS` |
| La connexion échoue alors que l'empreinte est en place | nom ou mot de passe différent de ceux de l'empreinte | `. /etc/conf.d/photo2pdf && python3 /opt/photo2pdf/server.py verify <nom>` |
| « trop de tentatives » (HTTP 429) | 5 échecs en moins de 5 min | attends, puis réessaie |
| « Envoi impossible : HTTP 500 » | `SCAN_DIR` non inscriptible | `chown -R photo2pdf:photo2pdf /srv/scans` |
| Rien ne répond | port fermé ou service arrêté | `ss -ltnp \| grep 8000`, `rc-service photo2pdf status` |
| Le service ne démarre pas (OpenRC) | pidfile, droits ou chemin | `cat /var/log/photo2pdf.log` |
| Le PDF dépasse 2 Mo avec ⚠️ | trop de pages ou photo en couleur | repasse en gris, réduis le nombre de pages |
| L'ancienne version reste affichée | cache de la PWA | ferme l'app depuis le sélecteur d'apps |
