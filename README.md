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
    docs/DEPLOIEMENT.md   tutoriel de déploiement et de configuration
    Dockerfile            image python:3-alpine, non-root
    test-core.cjs         auto-tests des fonctions pures
    test-pdf.cjs          auto-test de la structure du PDF

## Déploiement

Guide pas à pas : **[docs/DEPLOIEMENT.md](docs/DEPLOIEMENT.md)** — installation Alpine,
Debian ou Docker, configuration, HTTPS, installation iPhone, mise à jour, sauvegarde et
dépannage.

Le plus court chemin sur une LXC Alpine :

    apk add python3 git
    git clone https://github.com/Zephyrell/photo2pdf /opt/photo2pdf
    cd /opt/photo2pdf
    SCAN_DIR=/srv/scans python3 server.py

Pour un service permanent, utilise l'unité OpenRC livrée dans `deploy/`.

## Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `8000` | port d'écoute |
| `SCAN_DIR` | `./scans` | dossier où atterrissent les PDF |
| `SCAN_TOKEN` | vide | jeton exigé pour envoyer, lire et supprimer les PDF |

Sans `SCAN_TOKEN`, quiconque atteint le serveur peut déposer, lire et supprimer des PDF.
Détails et exemples par méthode d'installation dans le
[guide de déploiement](docs/DEPLOIEMENT.md#4-configuration).

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
