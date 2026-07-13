import { useLayoutEffect } from 'react';

export const LANGUAGE_STORAGE_KEY = 'passage-language';

export function getDefaultLanguage() {
  if (typeof navigator === 'undefined') return 'en';
  const preferred = Array.isArray(navigator.languages) && navigator.languages.length
    ? navigator.languages
    : [navigator.language];
  return preferred.some((language) => String(language).toLowerCase().startsWith('fr')) ? 'fr' : 'en';
}

export function getInitialLanguage() {
  try {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (saved === 'en' || saved === 'fr') return saved;
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  return getDefaultLanguage();
}

// Passage's original UI predates i18n and keeps its copy close to each chart.
// This catalogue deliberately uses the English copy as its key, which lets old
// snapshots and lazy-loaded panels participate without changing their schemas.
const FR = {
  'Loading passage instruments…': 'Chargement des instruments de navigation…',
  'Plan': 'Planifier',
  'Brief': 'Briefing',
  'Watch': 'Suivre',
  'Verify': 'Vérifier',
  'My limits': 'Mes limites',
  'My briefings': 'Mes briefings',
  'Causal brief': 'Briefing causal',
  'Evidence': 'Éléments probants',
  'Changes': 'Évolutions',
  'Track record': 'Bilan de fiabilité',
  'Case study': 'Étude de cas',
  'Skip to briefing content': 'Aller au contenu du briefing',
  'SNAPSHOT': 'BRIEFING',
  'Passage home': 'Accueil de Passage',
  'Passage stages': 'Étapes de Passage',
  'no briefing open yet': 'aucun briefing ouvert',
  'by DeepRegatta': 'par DeepRegatta',
  'Privacy': 'Confidentialité',
  'Terms': "Conditions d’utilisation",
  'Legal notice': 'Mentions légales',
  'DeepRegatta information': 'Informations DeepRegatta',
  'DeepRegatta legal and contact links': 'Liens juridiques et contact DeepRegatta',
  'A DeepRegatta instrument for offshore sailors': 'Un instrument DeepRegatta pour les navigateurs au large',
  'Plan a passage': 'Planifier une traversée',
  'Click the chart to drop waypoints (drag to adjust), or import a GPX file. The analysis runs right here in your browser.': 'Cliquez sur la carte pour placer des points de route (faites-les glisser pour les ajuster), ou importez un fichier GPX. L’analyse s’exécute directement dans votre navigateur.',
  'First time here?': 'Première visite ?',
  'See an example briefing': 'Voir un exemple de briefing',
  'Route mode': 'Mode de route',
  'Draw my route': 'Tracer ma route',
  'Compute a route': 'Calculer une route',
  'Name': 'Nom',
  'Boat speed (kt) — slow / usual / fast': 'Vitesse du bateau (nd) — lente / habituelle / rapide',
  'slow speed': 'vitesse lente',
  'nominal speed': 'vitesse habituelle',
  'fast speed': 'vitesse rapide',
  'Your boat (ORC polar)': 'Votre bateau (polaire ORC)',
  'Choose your boat…': 'Choisissez votre bateau…',
  'Search boat models': 'Rechercher des modèles de bateau',
  'Loading boat database…': 'Chargement de la base de bateaux…',
  'Boat models': 'Modèles de bateau',
  'Not listed? Generic by boat length': 'Absent de la liste ? Polaire générique selon la longueur',
  'Generic cruiser polars': 'Polaires génériques de croiseur',
  'Compute route': 'Calculer la route',
  'Click the chart twice: start, then finish. The route is computed from forecast wind, currents and your polar — then audited like any other route.': 'Cliquez deux fois sur la carte : départ, puis arrivée. La route est calculée à partir du vent prévu, des courants et de votre polaire, puis contrôlée comme toute autre route.',
  'computed route — inherits polar uncertainty; audited below like any route': 'route calculée — intègre l’incertitude de la polaire ; contrôlée ci-dessous comme toute autre route',
  'Departure (UTC)': 'Départ (UTC)',
  'undo': 'annuler',
  'clear': 'effacer',
  'Import GPX…': 'Importer un GPX…',
  'Check this passage against my limits': 'Vérifier cette traversée selon mes limites',
  'To enable: click the chart at least twice — your start and your destination.': 'Pour activer : cliquez au moins deux fois sur la carte — votre départ et votre destination.',
  'To enable: click the chart twice to set the two endpoints.': 'Pour activer : cliquez deux fois sur la carte afin de définir les deux extrémités.',
  'Checking runs the analysis and saves the briefing to My briefings. Until then your draft stays here on this page.': 'La vérification lance l’analyse et enregistre le briefing dans Mes briefings. Jusque-là, votre brouillon reste sur cette page.',
  'Compare departure times (next 5 days)': 'Comparer les heures de départ (5 prochains jours)',
  'Departure comparison ready — see the full-width calendar below the chart.': 'Comparaison des départs prête — consultez le calendrier pleine largeur sous la carte.',
  'Runs in your browser · forecasts fetched live · saved as an immutable snapshot.': 'S’exécute dans votre navigateur · prévisions récupérées en direct · enregistrement sous forme de briefing immuable.',
  'Departure comparison': 'Comparaison des départs',
  'Departure comparison · next 5 days': 'Comparaison des départs · 5 prochains jours',
  'same route, different weather': 'même route, météo différente',
  'each departure sails its own computed route': 'chaque départ suit sa propre route calculée',
  'Which models are behind these numbers?': 'Quels modèles produisent ces chiffres ?',
  'Checking a passage · comparing departures': 'Vérification d’une traversée · comparaison des départs',
  'Computing a route (and per-departure routes)': 'Calcul d’une route (et des routes par départ)',
  'My briefings': 'Mes briefings',
  "Every briefing is kept exactly as it was made — so you can re-read it later and see how the forecast actually did (that's the Track record page).": 'Chaque briefing est conservé exactement tel qu’il a été créé — vous pouvez ainsi le relire plus tard et voir la performance réelle de la prévision (dans la page Bilan de fiabilité).',
  'No analyses yet. Run one from the repo root:': 'Aucune analyse pour le moment. Lancez-en une depuis la racine du dépôt :',
  'example': 'exemple',
  'Delete this briefing': 'Supprimer ce briefing',
  'My limits': 'Mes limites',
  'Your declared limits': 'Vos limites déclarées',
  'These are operational limits you declare — not sailor categories. Presets only pre-fill; everything is editable. No preset relaxes squall or storm tolerance.': 'Ce sont les limites opérationnelles que vous déclarez, et non des catégories de marins. Les préréglages ne font que préremplir les champs ; tout reste modifiable. Aucun préréglage n’assouplit la tolérance aux grains ou aux tempêtes.',
  'CLI analyses read config/profiles/default-limits.json; this draft feeds in-browser analysis when it lands.': 'Les analyses en ligne de commande lisent config/profiles/default-limits.json ; ce brouillon alimente l’analyse dans le navigateur.',
  'Max sustained · upwind': 'Vent moyen max. · près',
  'Max sustained · reach': 'Vent moyen max. · travers',
  'Max sustained · downwind': 'Vent moyen max. · portant',
  'Max gusts': 'Rafales max.',
  'Max wave height': 'Hauteur de vague max.',
  'Max steepness': 'Cambrure max.',
  'Min visibility': 'Visibilité min.',
  'Scenario fraction floor': 'Seuil de fraction des scénarios',
  'night sailing acceptable': 'navigation de nuit acceptable',
  'Loading profile…': 'Chargement du profil…',
  'Data providers': 'Fournisseurs de données',
  'Feeds marked': 'Les flux marqués',
  'produce synthetic values for testing — they are badged everywhere they appear and must never inform a real passage decision.': 'produisent des valeurs synthétiques pour les tests — ils sont signalés partout et ne doivent jamais guider une décision de traversée réelle.',
  'Glossary': 'Glossaire',
  'Open a snapshot first.': 'Ouvrez d’abord un briefing.',
  'No ensemble limit claim is available for this snapshot.': 'Aucune affirmation de limite issue de l’ensemble n’est disponible pour ce briefing.',
  'raw fraction — not a calibrated probability': 'fraction brute — pas une probabilité étalonnée',
  'inspect claim': 'examiner l’affirmation',
  'Open a briefing to view its case study.': 'Ouvrez un briefing pour voir son étude de cas.',
  'Open a passage briefing first.': 'Ouvrez d’abord un briefing de traversée.',
  'First analysis of this passage': 'Première analyse de cette traversée',
  'Nothing to compare yet. Reassess after the next model run.': 'Rien à comparer pour le moment. Réévaluez après la prochaine sortie des modèles.',
  'Comparing frozen runs…': 'Comparaison des analyses figées…',
  'No material change; steadiness is recorded.': 'Aucun changement significatif ; la stabilité est enregistrée.',
  'Edited change story · previous → latest': 'Synthèse des évolutions · précédente → dernière',
  'Event onset at the route': 'Début de l’événement sur la route',
  'previous': 'précédente',
  'latest': 'dernière',
  'earlier': 'plus tôt',
  'later': 'plus tard',
  'Choose a claim': 'Choisir une affirmation',
  'Selected claim': 'Affirmation sélectionnée',
  'Rule': 'Règle',
  'Route window': 'Fenêtre sur la route',
  'Raw fraction': 'Fraction brute',
  'Limit': 'Limite',
  'Model comparison · same interval': 'Comparaison des modèles · même intervalle',
  'agreement is not proof': 'l’accord ne constitue pas une preuve',
  'Agreement is not proof. This panel stays tied to the claim selected at left.': 'L’accord ne constitue pas une preuve. Ce panneau reste lié à l’affirmation sélectionnée à gauche.',
  'Text/table alternative for the plume': 'Alternative texte/table au panache',
  'median': 'médiane',
  'maximum': 'maximum',
  'your limit': 'votre limite',
  'members over': 'membres au-dessus',
  'No ensemble data for this leg.': 'Aucune donnée d’ensemble pour ce tronçon.',
  'No multi-model data in this snapshot.': 'Aucune donnée multimodèle dans ce briefing.',
  'Evidence · model guidance': 'Éléments probants · indication des modèles',
  'Loading chart…': 'Chargement de la carte…',
  'Show detailed charts — wind · gusts · waves ▾': 'Afficher les graphiques détaillés — vent · rafales · vagues ▾',
  'Hide detailed charts ▴': 'Masquer les graphiques détaillés ▴',
  'Table alternative for route timeline': 'Tableau alternatif pour la chronologie de la route',
  'wind kt': 'vent nd',
  'gust kt': 'rafale nd',
  'waves m': 'vagues m',
  'status': 'état',
  'not assessed': 'non évalué',
  'Wind': 'Vent',
  'Gusts': 'Rafales',
  'Waves': 'Vagues',
  'knots': 'nœuds',
  'metres': 'mètres',
  'Before/after synoptic comparison unavailable for this legacy pair.': 'Comparaison synoptique avant/après indisponible pour cette ancienne paire.',
  'Previous': 'Précédente',
  'Latest': 'Dernière',
  'chart image no longer archived': 'image de la carte non archivée',
  'Synoptic chart unavailable': 'Carte synoptique indisponible',
  'This legacy run has route conditions, but no archived synoptic data.': 'Cette ancienne analyse contient les conditions sur la route, mais aucune donnée synoptique archivée.',
  'No tracked weather system meets your route in this window.': 'Aucun système météo suivi ne rencontre votre route dans cette fenêtre.',
  'The system is organizing west of the passage.': 'Le système s’organise à l’ouest de la traversée.',
  'The low and the boat occupy the same route window.': 'La dépression et le bateau occupent la même fenêtre sur la route.',
  'The system has crossed; the strongest route consequence is active.': 'Le système est passé ; son effet le plus fort sur la route est actif.',
  'The low moves clear and the passage begins to ease.': 'La dépression s’éloigne et les conditions commencent à s’améliorer.',
  'No tracked system crosses your route window — this pattern still sets your wind.': 'Aucun système suivi ne traverse votre fenêtre de route — cette configuration détermine néanmoins votre vent.',
  'Full screen': 'Plein écran',
  'Full chart': 'Carte entière',
  'Zoom to route': 'Zoomer sur la route',
  'Hide safer departure': 'Masquer le départ plus sûr',
  'Compare safer departure': 'Comparer un départ plus sûr',
  'Causal briefing playback': 'Lecture du briefing causal',
  'Close full-screen chart': 'Fermer la carte plein écran',
  'Pause passage playback': 'Mettre la lecture en pause',
  'Play passage playback': 'Lancer la lecture de la traversée',
  'Passage time': 'Temps de traversée',
  'departure': 'départ',
  'arrival': 'arrivée',
  'The weather story': 'L’histoire météo',
  'Nothing in this forecast crosses the limits you set. The final call is always yours — check once more before you leave.': 'Rien dans cette prévision ne dépasse les limites que vous avez fixées. La décision finale vous appartient toujours — vérifiez encore une fois avant de partir.',
  'It is close to your limits. Read the two or three points on the right before deciding.': 'Les conditions sont proches de vos limites. Lisez les deux ou trois points à droite avant de décider.',
  'This forecast goes beyond what you said you would accept. Look at WHEN — a different departure often fixes it.': 'Cette prévision dépasse ce que vous avez déclaré acceptable. Regardez QUAND — un autre départ résout souvent le problème.',
  'The forecast models tell different stories right now. Wait for the next update before deciding — the time is listed below.': 'Les modèles de prévision divergent actuellement. Attendez la prochaine mise à jour avant de décider — l’heure est indiquée ci-dessous.',
  'There is an official marine warning for your area. Start with the bulletin — everything else comes second.': 'Une alerte marine officielle concerne votre zone. Commencez par le bulletin — tout le reste vient ensuite.',
  'An official marine warning covers part of your route — read the bulletin before anything else.': 'Une alerte marine officielle couvre une partie de votre route — lisez le bulletin avant toute autre chose.',
  'Authority styling refused: this warning comes from synthetic data.': 'Présentation officielle refusée : cette alerte provient de données synthétiques.',
  'Your passage on the chart — the boat moves with the playback': 'Votre traversée sur la carte — le bateau avance avec la lecture',
  'Along your route · conditions vs your limits': 'Le long de votre route · conditions et limites',
  'same time cursor': 'même curseur temporel',
  'Decision': 'Décision',
  'Within your declared limits': 'Dans vos limites déclarées',
  'Approaching your limits': 'Proche de vos limites',
  'Exceeds your limits': 'Dépasse vos limites',
  'Insufficient forecast confidence — reassess at the next model run': 'Confiance insuffisante dans la prévision — réévaluez lors de la prochaine sortie des modèles',
  'Insufficient forecast confidence': 'Confiance insuffisante dans la prévision',
  'Official warning active': 'Alerte officielle active',
  '— takes precedence over the personal-limit assessment below': '— prévaut sur l’évaluation des limites personnelles ci-dessous',
  'driven by': 'déterminé par',
  'within limits': 'dans les limites',
  'approaching': 'proche des limites',
  'exceeds': 'dépassement',
  'models disagree': 'divergence des modèles',
  'official warning': 'alerte officielle',
  'exceeded': 'dépassé',
  'unknown': 'inconnu',
  'EMULATED WARNING SCENARIO': 'SCÉNARIO D’ALERTE SIMULÉ',
  'emulated warning scenario': 'scénario d’alerte simulé',
  'emulated': 'simulé',
  'evidence': 'éléments probants',
  'Capability coverage': 'Couverture fonctionnelle',
  'derived from evidence · legacy snapshot': 'déduit des éléments probants · ancien briefing',
  'Published verification case · frozen snapshot': 'Cas de vérification publié · briefing figé',
  'What the forecast said, and what happened': 'Ce que prévoyait la météo et ce qui s’est produit',
  'Print / save PDF': 'Imprimer / enregistrer en PDF',
  'Observations not attached yet': 'Observations pas encore jointes',
  'The original forecast remains frozen. This report will populate only after observations are classified.': 'La prévision initiale reste figée. Ce rapport ne sera complété qu’après la classification des observations.',
  'The route forecast captured the event direction; the table below shows the remaining timing and magnitude error without hindsight edits.': 'La prévision sur la route a correctement indiqué l’évolution de l’événement ; le tableau ci-dessous présente l’erreur restante de chronologie et d’intensité, sans réécriture a posteriori.',
  'Error decomposition': 'Décomposition de l’erreur',
  'variable': 'variable',
  'frozen forecast': 'prévision figée',
  'later observation': 'observation ultérieure',
  'error': 'erreur',
  'interpretation': 'interprétation',
  'Original interpretation': 'Interprétation initiale',
  'Corrected interpretation': 'Interprétation corrigée',
  'Treat the event timing as a window, preserve the personal limit, and use the verified error as extra margin—not as a reason to rewrite the frozen forecast.': 'Traitez la chronologie de l’événement comme une fenêtre, conservez votre limite personnelle et utilisez l’erreur vérifiée comme marge supplémentaire — pas comme prétexte pour réécrire la prévision figée.',
  'Track record': 'Bilan de fiabilité',
  'Corpus summary unavailable.': 'Résumé du corpus indisponible.',
  'This analysis': 'Cette analyse',
  'Calibration record — the track record this tool must earn': 'Historique d’étalonnage — la fiabilité que cet outil doit démontrer',
  'forecast': 'prévision',
  'observed': 'observé',
  'lead': 'échéance',
  'area': 'zone',
  'bias': 'biais',
  'spread': 'dispersion',
  'coverage': 'couverture',
  'Source bulletin': 'Bulletin source',
  'Marine bulletin': 'Bulletin marine',
  'Close bulletin': 'Fermer le bulletin',
  'Issued': 'Émis',
  'Valid': 'Valide',
  'Zones': 'Zones',
  'Start': 'Départ',
  'Finish': 'Arrivée',
  'dep': 'départ',
  'cause': 'cause',
  'interception': 'rencontre',
  'consequence': 'conséquence',
  'easing': 'amélioration',
  'Wind against current': 'Vent contre courant',
  'what sets this up': 'ce qui met en place cette situation',
  'while you are out there': 'pendant votre traversée',
  'right after your passage': 'juste après votre traversée',
  'easing off': 'en amélioration',
  'A weather system crosses your passage window': 'Un système météo traverse votre fenêtre de passage',
  'A low-pressure system crosses your passage window': 'Une dépression traverse votre fenêtre de passage',
  'A marine warning scenario covers part of your route — synthetic data, for testing the workflow only, never for a real passage decision.': 'Un scénario d’alerte marine couvre une partie de votre route — données synthétiques destinées uniquement à tester le fonctionnement, jamais à prendre une décision de traversée réelle.',
  'Why this assessment': 'Pourquoi cette évaluation',
  'Strongest': 'Conditions les plus fortes',
  'wind': 'vent',
  'around': 'vers',
  'The forecast updates': 'La prévision est mise à jour',
  'professional register': 'registre professionnel',
  'No analysis open.': 'Aucune analyse ouverte.',
  'Choose a snapshot': 'Choisir un briefing',
  'fine': 'dans les limites',
  'close to your limits': 'proche de vos limites',
  'beyond your limits': 'au-delà de vos limites',
  'the limit you set': 'la limite que vous avez fixée',
  'models split': 'divergence des modèles',
  'wind over tide': 'vent contre courant',
  'gate closed': 'porte fermée',
  'gate tight': 'porte difficile',
  'warning': 'alerte',
  'squalls?': 'grains ?',
  'leg': 'tronçon',
  'run': 'cycle',
  'age': 'âge',
  'models in agreement across this passage': 'modèles concordants sur toute la traversée',
  'Global models under-resolve coastal wind acceleration, harbours and tidal races; ocean-model currents are not tidal stream predictions.': 'Les modèles globaux représentent mal l’accélération côtière du vent, les ports et les raz de marée ; les courants des modèles océaniques ne sont pas des prévisions de courants de marée.',
  'synoptic situation': 'situation synoptique',
  'no attributed system': 'aucun système attribué',
  'system': 'système',
  'boat': 'bateau',
  'Synoptic pressure chart': 'Carte de pression synoptique',
  'track and route occupancy': 'trajectoire et occupation de la route',
  'Find a departure that fits': 'Trouver un départ adapté',
  'Open official bulletin': 'Ouvrir le bulletin officiel',
  'several times a day': 'plusieurs fois par jour',
  'does not fit this departure': 'ne convient pas à ce départ',
  'only partly fits': 'ne convient que partiellement',
  'stream will be against you.': 'le courant vous sera contraire.',
  'Not assessed:': 'Non évalué :',
  'No flag does not mean no risk.': 'L’absence de signalement ne signifie pas l’absence de risque.',
  'Coverage derived conservatively from evidence in this legacy snapshot.': 'Couverture déduite avec prudence des éléments probants de cet ancien briefing.',
  'assessed': 'évalué',
  'assessed emulated': 'évalué (simulé)',
  'Evidence inspector': 'Inspecteur des éléments probants',
  'Close inspector': 'Fermer l’inspecteur',
  'Leg & window': 'Tronçon et fenêtre',
  'Legs': 'Tronçons',
  'Data source': 'Source des données',
  'Model run': 'Cycle du modèle',
  'Source age': 'Âge de la source',
  'Value vs declared limit': 'Valeur et limite déclarée',
  'not applicable': 'sans objet',
  'scenario': 'scénario',
  'Low': 'Dépression',
  'Zoom in': 'Zoom avant',
  'Zoom out': 'Zoom arrière',
  'Agreement is not proof. Models share observations and assumptions; disagreement mainly says when to wait for the next run.': 'L’accord ne constitue pas une preuve. Les modèles partagent des observations et des hypothèses ; leur divergence indique surtout quand attendre le prochain cycle.',
  'The national weather service has an active marine warning covering part of your route. Official forecasts are the authority — read the bulletin before anything else.': 'Le service météorologique national a émis une alerte marine active couvrant une partie de votre route. Les prévisions officielles font autorité — lisez le bulletin avant toute autre chose.',
  'The weather system driving this': 'Le système météo à l’origine de la situation',
  'A strengthening low-pressure system sits west of the approaches, at your latitude — that is what sets the wind pattern over your route. The chart panels show how it moves over the next days.': 'Une dépression qui se renforce se trouve à l’ouest des approches, à votre latitude — elle détermine le régime de vent sur votre route. Les cartes montrent son déplacement au cours des prochains jours.',
  'Route impact, leg by leg': 'Effet sur la route, tronçon par tronçon',
  'What the forecast means for each stretch of your passage:': 'Ce que la prévision implique pour chaque tronçon de votre traversée :',
  'Against your declared limits': 'Par rapport à vos limites déclarées',
  'What could change': 'Ce qui pourrait changer',
  'Not assessed by this analysis': 'Non évalué par cette analyse',
  'Emulated data in this analysis': 'Données simulées dans cette analyse',
  'Some values in this briefing come from EMULATED (synthetic) data sources, marked with a badge. Do not use them for a real passage decision.': 'Certaines valeurs de ce briefing proviennent de sources de données SIMULÉES (synthétiques), signalées par un badge. Ne les utilisez pas pour prendre une décision de traversée réelle.',
  'sustained wind': 'vent moyen',
  'visibility and convection': 'visibilité et convection',
  'model agreement': 'concordance des modèles',
  'tidal currents': 'courants de marée',
  'tidal gates': 'portes de marée',
  'official warnings': 'alertes officielles',
  'synoptic attribution': 'attribution synoptique',
  'tropical systems': 'systèmes tropicaux',
  'ice': 'glace',
  'partially assessed': 'partiellement évalué',
  'Claim-level evidence': 'Éléments probants au niveau de l’affirmation',
  'Evidence claims': 'Affirmations étayées',
  'of': 'sur',
  'over': 'au-dessus',
  'exceedance window': 'fenêtre de dépassement',
  'YOUR limit': 'VOTRE limite',
  '10 m sustained': 'vent moyen à 10 m',
  'How the forecasts in your briefings compared with what actually happened. This is the page where the tool earns (or loses) your trust — every number carries its sample size and how independent the observation really was.': 'Comparaison entre les prévisions de vos briefings et ce qui s’est réellement produit. C’est ici que l’outil gagne — ou perd — votre confiance : chaque chiffre indique la taille de l’échantillon et le degré d’indépendance réel de l’observation.',
  'Reanalysis-referenced comparisons use ERA5, which assimilates observations but is not independent ground truth (brief §9). Sample sizes are always shown; no probability is called calibrated until they support it.': 'Les comparaisons fondées sur une réanalyse utilisent ERA5, qui assimile des observations mais ne constitue pas une vérité terrain indépendante (brief §9). La taille des échantillons est toujours indiquée ; aucune probabilité n’est dite étalonnée avant que les données ne le permettent.',
  'live': 'direct',
  'gust': 'rafale',
  'ensemble': 'ensemble',
  'forecast scenarios': 'scénarios de prévision',
  'ETA window': 'fenêtre d’arrivée estimée',
  'model run': 'cycle du modèle',
  'veer': 'adonnante',
  'significant wave height': 'hauteur significative des vagues',
  'steepness': 'cambrure',
  'tidal gate': 'porte de marée',
  'A brief burst of wind above the sustained speed — typically 20–40% higher; squalls can double it.': 'Une brève pointe de vent supérieure au vent moyen — généralement 20 à 40 % plus forte ; les grains peuvent la doubler.',
  'The same model run ~30 times with slightly different starting conditions (31 members for GEFS). The spread between members shows how uncertain the forecast is.': 'Le même modèle est exécuté environ 30 fois avec des conditions initiales légèrement différentes (31 membres pour GEFS). La dispersion entre les membres montre l’incertitude de la prévision.',
  'The ensemble members. "24 of 31 scenarios exceed your limit" is a raw count, not a calibrated probability — the member count always comes from the actual run.': 'Les membres de l’ensemble. « 24 scénarios sur 31 dépassent votre limite » est un décompte brut, pas une probabilité étalonnée — le nombre de membres provient toujours du cycle réel.',
  'Your arrival time is a range, not an instant: computed for your slow, usual and fast boat speeds. Conditions are checked across the whole window.': 'Votre heure d’arrivée est une plage, pas un instant : elle est calculée pour les vitesses lente, habituelle et rapide de votre bateau. Les conditions sont vérifiées sur toute la fenêtre.',
  'Weather models restart from fresh observations every 6–12 h. A new run can shift the forecast — always recheck before departure.': 'Les modèles météo redémarrent à partir de nouvelles observations toutes les 6 à 12 h. Un nouveau cycle peut décaler la prévision — vérifiez toujours avant le départ.',
  'Wind direction turning clockwise (e.g. SW → NW). Common behind a cold front.': 'Rotation du vent dans le sens horaire (p. ex. SO → NO). Fréquente derrière un front froid.',
  'The average of the highest third of waves. Individual waves can be nearly twice this height.': 'La moyenne du tiers des vagues les plus hautes. Certaines vagues peuvent atteindre près du double de cette hauteur.',
  'Wave height relative to wavelength. Steep waves break; short, steep seas are dangerous well below your height limit.': 'Rapport entre la hauteur et la longueur d’onde. Les vagues cambrées déferlent ; une mer courte et abrupte est dangereuse bien avant votre limite de hauteur.',
  'Wind blowing against the tidal stream — it makes waves shorter and steeper. Notorious in races like the Alderney Race.': 'Vent soufflant contre le courant de marée — il rend les vagues plus courtes et plus abruptes. Phénomène bien connu dans le raz Blanchard.',
  'A passage you must transit while the stream is fair (or slack). Miss the window and you fight a foul current — or worse seas.': 'Un passage à franchir lorsque le courant est favorable (ou à l’étale). Si vous manquez la fenêtre, vous affrontez un courant contraire — ou une mer plus difficile.',
};

const FR_PATTERNS = [
  [/^Plan views$/, 'Vues de planification'],
  [/^Brief views$/, 'Vues du briefing'],
  [/^Watch views$/, 'Vues du suivi'],
  [/^Verify views$/, 'Vues de vérification'],
  [/^SNAPSHOT$/, 'BRIEFING'],
  [/^SNAPSHOT /, 'BRIEFING '],
  [/^Start\s*→\s*Finish$/, 'Départ → Arrivée'],
  [/^dep (.+) UTC$/, 'départ $1 UTC'],
  [/^forecast updates ~(.+) — check again before you cast off$/, 'mise à jour des prévisions vers $1 — vérifiez à nouveau avant d’appareiller'],
  [/^The forecast updates around (.+) — check again before you cast off\.$/, 'La prévision est mise à jour vers $1 — vérifiez à nouveau avant d’appareiller.'],
  [/^The forecast updates several times a day — check again before you cast off\.$/, 'La prévision est mise à jour plusieurs fois par jour — vérifiez à nouveau avant d’appareiller.'],
  [/^A weather system crosses your passage window$/, 'Un système météo traverse votre fenêtre de passage'],
  [/^The forecast reaches ([\d.]+) (\w+) against your ([\d.]+) (\w+) limit (.+)\.$/, 'La prévision atteint $1 $2, pour une limite fixée à $3 $4, $5.'],
  [/^Strongest (.+)$/, 'Conditions les plus fortes $1'],
  [/^Wind over tide (.+) around (.+) UTC — expect short, steep seas\.$/, 'Vent contre courant $1 vers $2 UTC — attendez-vous à une mer courte et abrupte.'],
  [/^Wind opposes the current at (.+), increasing the risk of short, steep seas\.$/, 'Le vent s’oppose au courant au $1, ce qui augmente le risque de mer courte et abrupte.'],
  [/^Wind opposes the current (.+), increasing the risk of short, steep seas\.$/, 'Le vent s’oppose au courant $1, ce qui augmente le risque de mer courte et abrupte.'],
  [/^models diverge on (\d+) h of this passage$/, 'les modèles divergent pendant $1 h sur cette traversée'],
  [/^run (.+) · age (.+)$/, 'cycle $1 · âge $2'],
  [/^system undefined · boat (.+)$/, 'aucun système attribué · bateau $1'],
  [/^system (.+) · boat (.+)$/, 'système $1 · bateau $2'],
  [/^leg (\d+): approaching$/, 'tronçon $1 : proche des limites'],
  [/^leg (\d+): exceeded$/, 'tronçon $1 : limite dépassée'],
  [/^leg (\d+): ok$/, 'tronçon $1 : dans les limites'],
  [/^Previous run: Low (.+) is weaker and six hours slower\.$/, 'Analyse précédente : la dépression $1 est moins intense et retardée de six heures.'],
  [/^Previous run: (.+)$/, 'Analyse précédente : $1'],
  [/^Low (.+) track and route occupancy$/, 'Trajectoire de la dépression $1 et occupation de la route'],
  [/^High (.+) track and route occupancy$/, 'Trajectoire de l’anticyclone $1 et occupation de la route'],
  [/^gusts up to ([\d.]+) kt — close to your ([\d.]+) kt limit while the low crosses (.+)\.$/, 'rafales jusqu’à $1 nd — proches de votre limite de $2 nd pendant que la dépression traverse $3.'],
  [/^gusts up to ([\d.]+) kt — over your ([\d.]+) kt limit while the low crosses (.+)\.$/, 'rafales jusqu’à $1 nd — au-dessus de votre limite de $2 nd pendant que la dépression traverse $3.'],
  [/^(.+): fresh winds while you are on this stretch \((.+)\)\.(.*)$/, '$1 : vents frais pendant ce tronçon ($2).$3'],
  [/^(.+): strong winds while you are on this stretch \((.+)\)\.(.*)$/, '$1 : vents forts pendant ce tronçon ($2).$3'],
  [/^(.+): light winds while you are on this stretch \((.+)\)\.(.*)$/, '$1 : vents faibles pendant ce tronçon ($2).$3'],
  [/^Forecasts update several times a day\. Check again after the next model run \(expected around (.+) UTC\) — especially if you are close to your limits\.$/, 'Les prévisions sont mises à jour plusieurs fois par jour. Vérifiez à nouveau après le prochain cycle du modèle (attendu vers $1 UTC), surtout si les conditions sont proches de vos limites.'],
  [/^Conditions along your route: (.+)$/, 'Conditions le long de votre route : $1'],
  [/^(\d+) of (\d+)$/, '$1 sur $2'],
  [/^forecast scenarios exceed (.+) — raw fraction \((.+)\), not a calibrated probability$/, 'scénarios de prévision dépassent $1 — fraction brute ($2), pas une probabilité étalonnée'],
  [/^All (\d+) forecast scenarios exceed your (.+) limit (.+)\.$/, 'Les $1 scénarios de prévision dépassent votre limite de $2 $3.'],
  [/^(\d+) of (\d+) forecast scenarios exceed your (.+) limit (.+)\.$/, '$1 scénarios sur $2 dépassent votre limite de $3 $4.'],
  [/^near (.+)$/, 'près de $1'],
  [/^at (.+)$/, 'à $1'],
  [/^waypoint (\d+)$/, 'point de route $1'],
  [/^T\+(\d+): high ([^(]+) \((\d+) hPa\) (.+), building ([^,]+), quasi-stationary\. Tighter isobar spacing over (.+) means stronger wind there\.$/, 'T+$1 : anticyclone $2 ($3 hPa) $4, se renforçant de $5, quasi stationnaire. Le resserrement des isobares sur $6 y indique un vent plus fort.'],
  [/^T\+(\d+): low ([^(]+) \((\d+) hPa\) (.+), deepening ([^,]+), (.+)\.$/, 'T+$1 : dépression $2 ($3 hPa) $4, se creusant de $5, $6.'],
  [/^(\d+) waypoints$/, '$1 points de route'],
  [/^(\d+)\/2 endpoints$/, '$1/2 extrémités'],
  [/^departing (.+) UTC · made (.+)$/, 'départ $1 UTC · créé $2'],
  [/^(\d+) h old$/, 'il y a $1 h'],
  [/^1 pass · (\d+) fail · (\d+) pending$/, '1 réussite · $1 échecs · $2 en attente'],
  [/^(\d+) pass · 1 fail · (\d+) pending$/, '$1 réussites · 1 échec · $2 en attente'],
  [/^(\d+) pass · (\d+) fail · (\d+) pending$/, '$1 réussis · $2 échecs · $3 en attente'],
  [/^Skill claims use (\d+) real ERA5 cases\.$/, 'Les mesures de fiabilité reposent sur $1 cas ERA5 réels.'],
  [/^1 emulated cases shown for demo only\.$/, '1 cas simulé affiché uniquement pour la démonstration.'],
  [/^(\d+) emulated cases shown for demo only\.$/, '$1 cas simulés affichés uniquement pour la démonstration.'],
  [/^material change (\d+) · /, 'changement significatif $1 · '],
  [/^(.+) run$/, 'analyse $1'],
  [/^(.+) tracked positions$/, '$1 positions suivies'],
];

const FR_FRAGMENTS = [
  [/\bClaim-level evidence\b/g, 'Éléments probants au niveau de l’affirmation'],
  [/\bforecast scenarios exceed your\b/gi, 'scénarios de prévision dépassent votre'],
  [/\bEvidence claims\b/g, 'Affirmations étayées'],
  [/\bexceedance window\b/gi, 'fenêtre de dépassement'],
  [/\bYOUR limit\b/g, 'VOTRE limite'],
  [/\b10 m sustained\b/gi, 'vent moyen à 10 m'],
  [/\bPrevious run: Low (L\d+) is weaker and six hours slower\./g, 'Analyse précédente : la dépression $1 est moins intense et retardée de six heures.'],
  [/\bdeparting\b/gi, 'départ'],
  [/\bmade\b/gi, 'créé'],
  [/\bA low-pressure system crosses your passage window\b/g, 'Une dépression traverse votre fenêtre de passage'],
  [/\bA weather system crosses your passage window\b/g, 'Un système météo traverse votre fenêtre de passage'],
  [/\bPrevious run\b/gi, 'Analyse précédente'],
  [/\bLow (L\d+)\b/g, 'Dépression $1'],
  [/\bHigh (H\d+)\b/g, 'Anticyclone $1'],
  [/\btrack and route occupancy\b/gi, 'trajectoire et occupation de la route'],
  [/\bgusts up to\b/gi, 'rafales jusqu’à'],
  [/\bclose to your\b/gi, 'proches de votre'],
  [/\bover your\b/gi, 'au-dessus de votre'],
  [/\bwhile the low crosses\b/gi, 'pendant que la dépression traverse'],
  [/\bfresh winds while you are on this stretch\b/gi, 'vents frais pendant ce tronçon'],
  [/\bstrong winds while you are on this stretch\b/gi, 'vents forts pendant ce tronçon'],
  [/\blight winds while you are on this stretch\b/gi, 'vents faibles pendant ce tronçon'],
  [/\ball (\d+) forecast scenarios exceed your\b/gi, 'les $1 scénarios de prévision dépassent votre'],
  [/\b(\d+) of (\d+) forecast scenarios exceed your\b/gi, '$1 scénarios sur $2 dépassent votre'],
  [/The main signal:/gi, 'Signal principal :'],
  [/\bAn official marine warning covers part of your route\b/g, 'Une alerte marine officielle couvre une partie de votre route'],
  [/\bThat takes precedence over everything below\b/g, 'Elle prévaut sur tout ce qui suit'],
  [/\bForecasts update several times a day\b/g, 'Les prévisions sont mises à jour plusieurs fois par jour'],
  [/\bCheck again after the next model run\b/g, 'Vérifiez à nouveau après le prochain cycle du modèle'],
  [/\bexpected around\b/g, 'attendu vers'],
  [/\bespecially if you are close to your limits\b/g, 'surtout si les conditions sont proches de vos limites'],
  [/\bSome values in this briefing come from EMULATED \(synthetic\) data sources, marked with a badge\b/g, 'Certaines valeurs de ce briefing proviennent de sources de données SIMULÉES (synthétiques), signalées par un badge'],
  [/\bDo not use them for a real passage decision\b/g, 'Ne les utilisez pas pour prendre une décision de traversée réelle'],
  [/\bThis briefing does NOT cover\b/g, 'Ce briefing ne couvre PAS'],
  [/\bPartly assessed\b/g, 'Partiellement évalué'],
  [/\bNo warning here does not mean no risk\b/g, 'L’absence d’alerte ici ne signifie pas l’absence de risque'],
  [/\bNot assessed:/g, 'Non évalué :'],
  [/\bNo flag does not mean no risk\b/g, 'L’absence de signalement ne signifie pas l’absence de risque'],
  [/\btidal currents \(no prepared current grid\)/g, 'courants de marée (aucune grille de courants préparée)'],
  [/\btidal gates & HW\/LW heights \(no tide data\)/g, 'portes de marée et hauteurs PM/BM (aucune donnée de marée)'],
  [/\btropical systems\b/gi, 'systèmes tropicaux'],
  [/\bice\b/gi, 'glace'],
  [/\bpartially assessed\b/gi, 'partiellement évalué'],
  [/\bsustained wind\b/gi, 'vent moyen'],
  [/\bvisibility and convection\b/gi, 'visibilité et convection'],
  [/\bmodel agreement\b/gi, 'concordance des modèles'],
  [/\btidal currents\b/gi, 'courants de marée'],
  [/\btidal gates\b/gi, 'portes de marée'],
  [/\bofficial warnings\b/gi, 'alertes officielles'],
  [/\bsynoptic attribution\b/gi, 'attribution synoptique'],
  [/\bwind near\b/gi, 'vent près de'],
  [/\bwind\b/gi, 'vent'],
  [/\baround\b/gi, 'vers'],
  [/\bOff ([A-ZÀ-ÖØ-Ý][^→,.]*)/g, 'au large de $1'],
  [/\bNW of\b/g, 'NO de'],
  [/\bNE of\b/g, 'NE de'],
  [/\bSW of\b/g, 'SO de'],
  [/\bSE of\b/g, 'SE de'],
  [/\bE of\b/g, 'E de'],
  [/\bW of\b/g, 'O de'],
  [/\bPlymouth approach\b/gi, 'approche de Plymouth'],
  [/\bPlymouth breakwater\b/gi, 'brise-lames de Plymouth'],
  [/\bCasquets TSS crossing\b/gi, 'traversée du DST des Casquets'],
  [/\bMid-Channel\b/gi, 'milieu de la Manche'],
  [/\bwestern entrance\b/gi, 'entrée ouest'],
  [/\bwest of the Gulf of Lion\b/gi, 'à l’ouest du golfe du Lion'],
  [/\bthe Gulf of Lion\b/gi, 'le golfe du Lion'],
  [/\bthe eastern Channel\b/gi, 'l’est de la Manche'],
  [/\bforecast updates\b/gi, 'mise à jour des prévisions'],
  [/\bcheck again before you cast off\b/gi, 'vérifiez à nouveau avant d’appareiller'],
  [/\bThe forecast updates\b/g, 'La prévision est mise à jour'],
  [/\bThe forecast reaches\b/g, 'La prévision atteint'],
  [/\bagainst your\b/g, 'pour une limite de'],
  [/\blimit near\b/g, 'près de'],
  [/\bwhat sets this up\b/gi, 'ce qui met en place cette situation'],
  [/\bWind opposes the current\b/g, 'Le vent s’oppose au courant'],
  [/\bincreasing the risk of short, steep seas\b/g, 'ce qui augmente le risque de mer courte et abrupte'],
  [/\bStrongest near\b/g, 'Conditions les plus fortes près de'],
  [/\bnear waypoint\b/g, 'près du point de route'],
  [/\bwaypoint\s+(\d+)\b/gi, 'point de route $1'],
  [/\bwp(\d+)\b/gi, 'point de route $1'],
  [/\bgusts\b/gi, 'rafales'],
  [/\bwaves\b/gi, 'vagues'],
  [/\bWind over tide\b/g, 'Vent contre courant'],
  [/\bexpect short, steep seas\b/g, 'attendez-vous à une mer courte et abrupte'],
  [/\bWhy this assessment\b/g, 'Pourquoi cette évaluation'],
  [/\bmodels split\b/gi, 'divergence des modèles'],
  [/\bclose to your limits\b/gi, 'proche de vos limites'],
  [/\bbeyond your limits\b/gi, 'au-delà de vos limites'],
  [/\bfine\b/gi, 'dans les limites'],
  [/\bmodels diverge on\b/gi, 'les modèles divergent pendant'],
  [/\bof this passage\b/gi, 'sur cette traversée'],
  [/\bmodels in agreement across this passage\b/gi, 'modèles concordants sur toute la traversée'],
  [/\brun (\d{4}-\d{2}-\d{2}T[^ ]+) · age\b/g, 'cycle $1 · âge'],
  [/\bsystem undefined\b/gi, 'aucun système attribué'],
  [/\bsystem\b/gi, 'système'],
  [/\bboat\b/gi, 'bateau'],
  [/\bcause · Wind against current\b/gi, 'cause · Vent contre courant'],
  [/\blimits\b/gi, 'limites'],
  [/\blimit\b/gi, 'limite'],
  [/\bkt\b/g, 'nd'],
  [/(\d)kt\b/g, '$1 nd'],
  [/(\d) NM\b/g, '$1 M'],
  [/\bStart\b/g, 'Départ'],
  [/\bFinish\b/g, 'Arrivée'],
  [/proches de votre limites/gi, 'proches de vos limites'],
  [/proche de votre limites/gi, 'proche de vos limites'],
  [/proches de votre (\d+(?:\.\d+)?) nd limite/gi, 'proches de votre limite de $1 nd'],
  [/au-dessus de votre (\d+(?:\.\d+)?) nd limite/gi, 'au-dessus de votre limite de $1 nd'],
  [/votre limite de (\d+(?:\.\d+)?) nd vent/gi, 'votre limite de vent de $1 nd'],
  [/votre (\d+(?:\.\d+)?) nd vent limite/gi, 'votre limite de vent de $1 nd'],
  [/votre vent limite/gi, 'votre limite de vent'],
  [/\b(\d+) of (\d+)\b/g, '$1 sur $2'],
  [/\b(\d+)\/(\d+) over\b/g, '$1/$2 au-dessus'],
  [/votre (\d+(?:\.\d+)?) nd limite/gi, 'votre limite de $1 nd'],
  [/ limite on /gi, ' limite sur '],
  [/près de approche de Plymouth/gi, 'près de l’approche de Plymouth'],
  [/mise à jour des prévisions\s*~/gi, 'mise à jour des prévisions vers '],
  [/default-limites\.json/g, 'default-limits.json'],
];

const FR_DATE_PARTS = {
  Sun: 'dim.', Mon: 'lun.', Tue: 'mar.', Wed: 'mer.', Thu: 'jeu.', Fri: 'ven.', Sat: 'sam.',
  Jan: 'janv.', Feb: 'févr.', Mar: 'mars', Apr: 'avr.', May: 'mai', Jun: 'juin',
  Jul: 'juil.', Aug: 'août', Sep: 'sept.', Oct: 'oct.', Nov: 'nov.', Dec: 'déc.',
};

function localizeDateParts(text) {
  return text.replace(/\b(Sun|Mon|Tue|Wed|Thu|Fri|Sat|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g, (part) => FR_DATE_PARTS[part]);
}

export function translateText(value, language) {
  if (language !== 'fr' || !value) return value;
  const leading = value.match(/^\s*/)?.[0] ?? '';
  const trailing = value.match(/\s*$/)?.[0] ?? '';
  const key = value.trim();
  if (!key) return value;
  let translated = FR[key];
  if (!translated) {
    for (const [pattern, replacement] of FR_PATTERNS) {
      if (pattern.test(key)) {
        translated = key.replace(pattern, replacement);
        break;
      }
    }
  }
  translated ??= key;
  for (const [pattern, replacement] of FR_FRAGMENTS) translated = translated.replace(pattern, replacement);
  translated = localizeDateParts(translated);
  return `${leading}${translated}${trailing}`;
}

const originalText = new WeakMap();
const originalAttrs = new WeakMap();
const ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt'];

function localize(root, language) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('script, style, pre, code')) continue;
    let original = originalText.get(node);
    if (original === undefined || (node.data !== original && node.data !== translateText(original, 'fr'))) {
      original = node.data;
      originalText.set(node, original);
    }
    const next = translateText(original, language);
    if (node.data !== next) node.data = next;
  }

  for (const element of root.querySelectorAll('*')) {
    let originals = originalAttrs.get(element);
    if (!originals) {
      originals = new Map();
      originalAttrs.set(element, originals);
    }
    for (const attr of ATTRIBUTES) {
      if (!element.hasAttribute(attr)) continue;
      const current = element.getAttribute(attr);
      let original = originals.get(attr);
      if (original === undefined || (current !== original && current !== translateText(original, 'fr'))) {
        original = current;
        originals.set(attr, original);
      }
      const next = translateText(original, language);
      if (current !== next) element.setAttribute(attr, next);
    }
  }
}

export function LocalizedDocument({ language }) {
  useLayoutEffect(() => {
    const root = document.getElementById('root') ?? document.body;
    document.documentElement.lang = language;
    document.title = language === 'fr'
      ? 'Passage par DeepRegatta | Planification météo de traversée'
      : 'Passage by DeepRegatta | Passage weather planning';
    const description = language === 'fr'
      ? 'Planifiez vos traversées à la voile avec routage météo en direct, analyse explicable des risques et briefings adaptés à la route.'
      : 'Plan sailing passages with live weather routing, explainable forecast risk, and route-specific briefings from Passage by DeepRegatta.';
    document.querySelector('meta[name="description"]')?.setAttribute('content', description);
    document.querySelector('meta[property="og:locale"]')?.setAttribute('content', language === 'fr' ? 'fr_FR' : 'en_US');

    let queued = false;
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        observer.disconnect();
        localize(root, language);
        observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });
      });
    });
    localize(root, language);
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });
    return () => observer.disconnect();
  }, [language]);

  return null;
}
