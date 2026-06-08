# Upscale + Unmarker

Site frontend compatible GitHub Pages pour traiter des images en lot:

1. selection multiple d'images;
2. upscale local x2, x3 ou x4 via Canvas;
3. passage automatique dans le pipeline Unmarker extrait du repo fourni;
4. export JPG;
5. telechargement image par image ou dans un ZIP.

Tout tourne dans le navigateur. Il n'y a pas de backend, pas d'upload serveur et pas d'API externe.

## Fonctionnement

- `src/App.tsx` contient l'interface batch.
- `src/lib/batchProcessor.ts` orchestre l'upscale puis Unmarker.
- `src/lib/pipeline.ts` conserve les etapes Unmarker originales: shake, stir et crush.
- `src/lib/geminiWorkerClient.ts` et `src/workers/geminiVisible.worker.ts` conservent la detection/restauration locale du watermark visible Gemini quand elle est possible.
- `src/lib/storedZip.ts` genere un ZIP directement en frontend, sans dependance serveur.

Les images sont traitees en serie pour limiter la memoire du navigateur. La sortie est toujours un JPG nettoye.

## Limites

- L'upscale est un upscale navigateur haute qualite via Canvas, pas un modele IA distant.
- Une image finale est limitee a 64 megapixels apres upscale pour eviter les crashs memoire.
- Les formats doivent etre lisibles par le navigateur pour passer dans Canvas.
- Le pipeline Unmarker est heuristique: il perturbe les traces visibles/statistiques, mais ne garantit pas la suppression universelle de tous les watermarks.
- Le worker OpenCV du repo d'origine genere un fichier de build d'environ 10.8 MB.

## Installation

```bash
npm install
```

## Developpement

```bash
npm run dev
```

## Verification

```bash
npm run lint
npm test
npm run build
```

## Deploiement GitHub Pages

Le projet est configure avec `base: './'` dans `vite.config.ts`, donc le dossier `dist/` peut etre servi depuis un sous-chemin GitHub Pages.

Build:

```bash
npm run build
```

Publier ensuite le contenu de `dist/` avec GitHub Pages, ou via une action GitHub qui build puis publie ce dossier.

## Licence

Le code de base vient du repo Unmarker.it fourni et conserve sa licence MIT.
