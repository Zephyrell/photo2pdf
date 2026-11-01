# Photo2pdf

Photo de facture → PDF sous 2 Mo, depuis l'iPhone. PWA auto-hébergée, **sans compte
développeur Apple**.

- Recadrage manuel 4 coins avec redressement de perspective
- Rendu scanner : fond blanchi localement (éclairage inégal corrigé), niveaux de gris
  (ou couleur), contraste étalé
- PDF A4 dont la qualité et la résolution descendent par paliers jusqu'à tenir sous 2 Mo
- Partage iOS (Mail, Fichiers, AirDrop…), archivage sur le serveur et historique
  (relecture / suppression des PDF déjà envoyés)

Tout le traitement se fait sur le téléphone. Le serveur sert les fichiers et reçoit le
PDF final, rien d'autre.

## Lancer en local

    python3 server.py
    # → http://localhost:8000

Aucune dépendance : serveur en stdlib Python, front en JS natif, aucun build. Les PDF reçus
vont dans `scans/` (surchargeable par `SCAN_DIR`).

## Structure

    index.html            interface, styles, éditeur de recadrage
    app.js                pipeline : décodage, perspective, rendu, optimisation, PDF
    core.js               maths et traitement d'image, sans DOM (testable sous Node)
    pdf.js                écrivain PDF minimal, zéro dépendance
    server.py             statique + API d'envoi et d'historique
    deploy/               unités systemd et OpenRC, /etc/conf.d
    Dockerfile            image python:3-alpine, non-root
    test-core.cjs         auto-tests des fonctions pures
    test-pdf.cjs          auto-test de la structure du PDF

## Déployer sur un LXC

Une seule dépendance : `python3`. Pas de build, pas de paquet Python.

### Alpine (OpenRC)

    apk add python3 git
    git clone https://github.com/Zephyrell/photo2pdf /opt/photo2pdf
    adduser -D -H -s /sbin/nologin photo2pdf
    mkdir -p /srv/scans && chown photo2pdf:photo2pdf /srv/scans
    install -m 755 /opt/photo2pdf/deploy/photo2pdf.openrc /etc/init.d/photo2pdf
    install -m 644 /opt/photo2pdf/deploy/photo2pdf.confd /etc/conf.d/photo2pdf
    rc-update add photo2pdf default
    rc-service photo2pdf start

Les réglages (`SCAN_DIR`, `PORT`, `SCAN_TOKEN`) vont dans `/etc/conf.d/photo2pdf`.

### Debian / Ubuntu (systemd)

    apt install python3 git
    git clone https://github.com/Zephyrell/photo2pdf /opt/photo2pdf
    useradd -r -s /usr/sbin/nologin photo2pdf
    mkdir -p /srv/scans && chown photo2pdf:photo2pdf /srv/scans
    install -m 644 /opt/photo2pdf/deploy/photo2pdf.service /etc/systemd/system/
    systemctl enable --now photo2pdf

Mise à jour : `git -C /opt/photo2pdf pull`, puis `rc-service photo2pdf restart` (Alpine) ou
`systemctl restart photo2pdf`.

## Docker

    mkdir -p scans && sudo chown -R 10001:10001 scans   # l'image tourne sans root
    SCAN_TOKEN=change-moi docker compose up -d --build

Le dossier `scans/` de l'hôte reçoit les PDF. Image basée sur `python:3-alpine`, ~60 Mo.
Sur un LXC Proxmox, Docker a besoin de l'imbrication :

    pct set <id> --features nesting=1

## HTTPS

Indispensable pour que le partage de fichiers et le mode plein écran fonctionnent. Au choix :

- le reverse proxy existant (nginx / Caddy / Traefik) vers `127.0.0.1:8000`
- `tailscale serve --bg 8000` → HTTPS sur le tailnet
- Cloudflare Tunnel

Exemple nginx :

    location / {
        proxy_pass http://127.0.0.1:8000;
        client_max_body_size 10m;
    }

## Sur l'iPhone

Safari → l'URL → Partager → « Sur l'écran d'accueil ».

Si `SCAN_TOKEN` est défini côté serveur, ouvrir une fois `https://…/?token=…` : le jeton
est mémorisé sur l'appareil.

Le bouton **Historique serveur** liste les PDF déjà envoyés et permet de les rouvrir ou de
les supprimer. Ils passent par `/api/scans` : le dossier `scans/` n'est jamais servi en
statique. Le jeton y est donc aussi obligatoire — sans `SCAN_TOKEN`, quiconque atteint le
serveur peut déposer, lire et supprimer des PDF.

## Tests

    node test-pdf.cjs     # structure du PDF, rendu vérifiable par qlmanage
    node test-core.cjs    # homographie, échantillonnage bilinéaire, rendu gris/couleur

## Limites connues

- Pas d'OCR : le PDF n'a pas de couche texte.
- Pas de mode hors-ligne (pas de service worker).
- Réordonnancement par flèches (pas de glisser-déposer).
- Sous 2 Mo, la boucle baisse la qualité puis la résolution : au-delà d'environ 6 pages
  couleur, le rendu se dégrade visiblement.
- Tout est traité côté client : une facture photographiée reste sur l'appareil jusqu'à
  l'envoi.

## Licence

MIT — voir [LICENSE](LICENSE).
