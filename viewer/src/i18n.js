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
  'evidence:': 'éléments probants :',
  'NM': 'M',
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
  'Boat speed (kt) · slow / usual / fast': 'Vitesse du bateau (nd) · lente / habituelle / rapide',
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
  'Mark a start and finish on the chart. Passage uses the forecast, available currents and your boat polar to find a route.': 'Placez un départ et une arrivée sur la carte. Passage utilise les prévisions, les courants disponibles et la polaire de votre bateau pour calculer une route.',
  'Weather-routed · includes polar uncertainty · ready to check': 'Route météo · incertitude de la polaire incluse · prête à vérifier',
  'Departure · local time': 'Départ · heure locale',
  'Departure date': 'Date de départ',
  'Departure time, 24-hour clock': 'Heure de départ, format 24 heures',
  '24-hour clock (HH:mm)': 'format 24 heures (HH:mm)',
  '24-hour local time': 'heure locale au format 24 heures',
  'your local time': 'votre heure locale',
  'local time': 'heure locale',
  'undo': 'annuler',
  'clear': 'effacer',
  'Import GPX…': 'Importer un GPX…',
  'Check this passage against my limits': 'Vérifier cette traversée selon mes limites',
  'Mark at least two points on the chart: your start and destination.': 'Placez au moins deux points sur la carte : votre départ et votre destination.',
  'Mark a start and finish on the chart.': 'Placez un départ et une arrivée sur la carte.',
  'Checking runs the analysis and saves the briefing to My briefings. Until then your draft stays here on this page.': 'La vérification lance l’analyse et enregistre le briefing dans Mes briefings. Jusque-là, votre brouillon reste sur cette page.',
  'Compare departure times (next 5 days)': 'Comparer les heures de départ (5 prochains jours)',
  'Departure comparison ready. Choose a time below the chart.': 'Comparaison des départs prête. Choisissez une heure sous la carte.',
  'Runs in your browser · forecasts fetched live · saved as an immutable snapshot.': 'S’exécute dans votre navigateur · prévisions récupérées en direct · enregistrement sous forme de briefing immuable.',
  'Departure comparison': 'Comparaison des départs',
  'Departure comparison · next 5 days': 'Comparaison des départs · 5 prochains jours',
  'same route, different weather': 'même route, météo différente',
  'each departure sails its own computed route': 'chaque départ suit sa propre route calculée',
  'Which models are behind these numbers?': 'Quels modèles produisent ces chiffres ?',
  'Checking a passage · comparing departures': 'Vérification d’une traversée · comparaison des départs',
  'Computing a route (and per-departure routes)': 'Calcul d’une route (et des routes par départ)',
  'My briefings': 'Mes briefings',
  'Briefings are frozen when you make them. Reopen one here, or compare its forecast with later observations in Track record.': 'Les briefings sont figés à leur création. Rouvrez-en un ici ou comparez sa prévision aux observations ultérieures dans le Bilan de fiabilité.',
  'No briefings yet.': 'Aucun briefing pour le moment.',
  'Plan a passage, set a departure time and check it against your limits.': 'Planifiez une traversée, choisissez une heure de départ et vérifiez-la selon vos limites.',
  'example': 'exemple',
  'Delete this briefing': 'Supprimer ce briefing',
  'My limits': 'Mes limites',
  'Your declared limits': 'Vos limites déclarées',
  'Set the conditions you will accept for this passage. Presets are only a starting point. Every value remains editable. Squall and storm tolerance never changes with a preset.': 'Définissez les conditions que vous acceptez pour cette traversée. Les préréglages sont un point de départ. Chaque valeur reste modifiable. La tolérance aux grains et aux tempêtes ne change jamais avec un préréglage.',
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
  'contain synthetic test values. They stay visibly marked and must never inform a real passage decision.': 'contiennent des valeurs synthétiques de test. Elles restent clairement signalées et ne doivent jamais guider une décision de traversée réelle.',
  'Glossary': 'Glossaire',
  'Open a snapshot first.': 'Ouvrez d’abord un briefing.',
  'No ensemble limit claim is available for this snapshot.': 'Aucune affirmation de limite issue de l’ensemble n’est disponible pour ce briefing.',
  'raw count, not a calibrated probability': 'décompte brut, pas une probabilité étalonnée',
  'inspect claim': 'examiner l’affirmation',
  'Open a briefing to view its case study.': 'Ouvrez un briefing pour voir son étude de cas.',
  'Open a passage briefing first.': 'Ouvrez d’abord un briefing de traversée.',
  'First analysis of this passage': 'Première analyse de cette traversée',
  'Nothing to compare yet. Reassess after the next model run.': 'Rien à comparer pour le moment. Réévaluez après la prochaine sortie des modèles.',
  'Comparing frozen runs…': 'Comparaison des analyses figées…',
  'No material change. The forecast held steady.': 'Aucun changement significatif. La prévision est restée stable.',
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
  'Show wind, gust and wave charts ▾': 'Afficher les graphiques du vent, des rafales et des vagues ▾',
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
  'No tracked system crosses your route window; this pattern still sets your wind.': 'Aucun système suivi ne traverse votre fenêtre de route; cette configuration détermine néanmoins votre vent.',
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
  'The forecast stays inside the limits you set. Check the latest run once more before you leave.': 'La prévision reste dans les limites fixées. Vérifiez une dernière fois le cycle le plus récent avant de partir.',
  'It is close to your limits. Read the two or three points on the right before deciding.': 'Les conditions sont proches de vos limites. Lisez les deux ou trois points à droite avant de décider.',
  'This forecast crosses your limits. Compare departure times before changing the route.': 'Cette prévision dépasse vos limites. Comparez les heures de départ avant de modifier la route.',
  'The models disagree near your limits. Wait for the next update before deciding.': 'Les modèles divergent près de vos limites. Attendez la prochaine mise à jour avant de décider.',
  'A marine warning covers your area. Read the official bulletin first.': 'Une alerte marine concerne votre zone. Lisez d’abord le bulletin officiel.',
  'An official marine warning covers part of your route. Read the bulletin before anything else.': 'Une alerte marine officielle couvre une partie de votre route. Lisez le bulletin en premier.',
  'Authority styling refused: this warning comes from synthetic data.': 'Présentation officielle refusée : cette alerte provient de données synthétiques.',
  'A synthetic warning scenario covers part of your route. It tests the workflow and must not inform a real passage decision.': 'Un scénario d’alerte synthétique couvre une partie de votre route. Il sert à tester le fonctionnement et ne doit jamais guider une décision réelle.',
  'Passage chart · synced to playback': 'Carte de la traversée · synchronisée avec la lecture',
  'Along your route · conditions vs your limits': 'Le long de votre route · conditions et limites',
  'same time cursor': 'même curseur temporel',
  'Decision': 'Décision',
  'Within your declared limits': 'Dans vos limites déclarées',
  'Approaching your limits': 'Proche de vos limites',
  'Exceeds your limits': 'Dépasse vos limites',
  'Models disagree · reassess after the next run': 'Divergence des modèles · réévaluez après le prochain cycle',
  'Insufficient forecast confidence': 'Confiance insuffisante dans la prévision',
  'Official warning active': 'Alerte officielle active',
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
  'The route forecast caught the event direction. The table records its timing and magnitude errors without hindsight edits.': 'La prévision sur la route a saisi l’évolution de l’événement. Le tableau consigne ses erreurs de chronologie et d’intensité sans réécriture a posteriori.',
  'Error decomposition': 'Décomposition de l’erreur',
  'variable': 'variable',
  'frozen forecast': 'prévision figée',
  'later observation': 'observation ultérieure',
  'error': 'erreur',
  'interpretation': 'interprétation',
  'Original interpretation': 'Interprétation initiale',
  'Lesson for the next passage': 'Leçon pour la prochaine traversée',
  'Treat event timing as a window. Keep your personal limit, then add the measured forecast error as margin.': 'Traitez la chronologie de l’événement comme une fenêtre. Conservez votre limite personnelle, puis ajoutez l’erreur de prévision mesurée comme marge.',
  'Track record': 'Bilan de fiabilité',
  'Corpus summary unavailable.': 'Résumé du corpus indisponible.',
  'This analysis': 'Cette analyse',
  'Calibration record': 'Historique d’étalonnage',
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
  'A marine warning scenario covers part of your route; synthetic data, for testing the workflow only, never for a real passage decision.': 'Un scénario d’alerte marine couvre une partie de votre route; données synthétiques destinées uniquement à tester le fonctionnement, jamais à prendre une décision de traversée réelle.',
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
  'Global models under-resolve coastal wind acceleration, harbours and tidal races. Ocean-model currents are not tidal stream predictions.': 'Les modèles globaux représentent mal l’accélération côtière du vent, les ports et les raz de marée. Les courants des modèles océaniques ne sont pas des prévisions de courants de marée.',
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
  'The national weather service has an active marine warning covering part of your route. Official forecasts are the authority; read the bulletin before anything else.': 'Le service météorologique national a émis une alerte marine active couvrant une partie de votre route. Les prévisions officielles font autorité; lisez le bulletin avant toute autre chose.',
  'The weather system driving this': 'Le système météo à l’origine de la situation',
  'A strengthening low-pressure system sits west of the approaches, at your latitude; that is what sets the wind pattern over your route. The chart panels show how it moves over the next days.': 'Une dépression qui se renforce se trouve à l’ouest des approches, à votre latitude; elle détermine le régime de vent sur votre route. Les cartes montrent son déplacement au cours des prochains jours.',
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
  'How the forecasts in your briefings compared with what actually happened. This is the page where the tool earns (or loses) your trust; every number carries its sample size and how independent the observation really was.': 'Comparaison entre les prévisions de vos briefings et ce qui s’est réellement produit. C’est ici que l’outil gagne; ou perd; votre confiance : chaque chiffre indique la taille de l’échantillon et le degré d’indépendance réel de l’observation.',
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
  'A brief burst of wind above the sustained speed; typically 20–40% higher; squalls can double it.': 'Une brève pointe de vent supérieure au vent moyen; généralement 20 à 40 % plus forte ; les grains peuvent la doubler.',
  'The same model run ~30 times with slightly different starting conditions (31 members for GEFS). The spread between members shows how uncertain the forecast is.': 'Le même modèle est exécuté environ 30 fois avec des conditions initiales légèrement différentes (31 membres pour GEFS). La dispersion entre les membres montre l’incertitude de la prévision.',
  'The ensemble members. "24 of 31 scenarios exceed your limit" is a raw count, not a calibrated probability; the member count always comes from the actual run.': 'Les membres de l’ensemble. « 24 scénarios sur 31 dépassent votre limite » est un décompte brut, pas une probabilité étalonnée; le nombre de membres provient toujours du cycle réel.',
  'Your arrival time is a range, not an instant: computed for your slow, usual and fast boat speeds. Conditions are checked across the whole window.': 'Votre heure d’arrivée est une plage, pas un instant : elle est calculée pour les vitesses lente, habituelle et rapide de votre bateau. Les conditions sont vérifiées sur toute la fenêtre.',
  'Weather models restart from fresh observations every 6–12 h. A new run can shift the forecast; always recheck before departure.': 'Les modèles météo redémarrent à partir de nouvelles observations toutes les 6 à 12 h. Un nouveau cycle peut décaler la prévision; vérifiez toujours avant le départ.',
  'Wind direction turning clockwise (e.g. SW → NW). Common behind a cold front.': 'Rotation du vent dans le sens horaire (p. ex. SO → NO). Fréquente derrière un front froid.',
  'The average of the highest third of waves. Individual waves can be nearly twice this height.': 'La moyenne du tiers des vagues les plus hautes. Certaines vagues peuvent atteindre près du double de cette hauteur.',
  'Wave height relative to wavelength. Steep waves break; short, steep seas are dangerous well below your height limit.': 'Rapport entre la hauteur et la longueur d’onde. Les vagues cambrées déferlent ; une mer courte et abrupte est dangereuse bien avant votre limite de hauteur.',
  'Wind blowing against the tidal stream; it makes waves shorter and steeper. Notorious in races like the Alderney Race.': 'Vent soufflant contre le courant de marée; il rend les vagues plus courtes et plus abruptes. Phénomène bien connu dans le raz Blanchard.',
  'A passage you must transit while the stream is fair (or slack). Miss the window and you fight a foul current; or worse seas.': 'Un passage à franchir lorsque le courant est favorable (ou à l’étale). Si vous manquez la fenêtre, vous affrontez un courant contraire; ou une mer plus difficile.',
};

const FR_PATTERNS = [
  [/^A (strengthening )?low-pressure system sits (.+); that is what sets the wind pattern over your route\. The chart panels show how it moves over the next days\.$/, (_match, strengthening, position) => `Une dépression${strengthening ? ' qui se renforce' : ''} se trouve ${translateSynopticPosition(position)}; elle détermine le régime de vent sur votre route. Les cartes montrent son déplacement au cours des prochains jours.`],
  [/^Low (L\d+) deepens west of the route\.$/, 'La dépression $1 se creuse à l’ouest de la route.'],
  [/^(.+): (light|moderate|fresh|strong|near-gale|gale-force) winds while you are on this stretch \((.+) UTC\)\.(.*)$/, (_match, leg, strength, window, suffix) => `${translateRouteName(leg)} : ${translateWindStrength(strength)} pendant ce tronçon (${window} UTC).${translateExceedanceSuffix(suffix)}`],
  [/^The forecasts disagree too much to assess this passage against your limits\. Reassess after the next model run\.(.*)$/, (_match, suffix) => `Les prévisions divergent trop pour évaluer cette traversée par rapport à vos limites. Réévaluez-la après le prochain cycle du modèle.${translateMainSignal(suffix)}`],
  [/^An official marine warning covers part of your route\. That takes precedence over everything below\.(.*)$/, (_match, suffix) => `Une alerte marine officielle couvre une partie de votre route. Elle prévaut sur tout ce qui suit.${translateMainSignal(suffix)}`],
  [/^Forecast conditions stay inside the limits you declared for this departure\.(.*)$/, (_match, suffix) => `Les conditions prévues restent dans les limites que vous avez déclarées pour ce départ.${translateMainSignal(suffix)}`],
  [/^Forecast conditions come close to the limits you declared\. Look at what is driving this before deciding\.(.*)$/, (_match, suffix) => `Les conditions prévues approchent des limites que vous avez déclarées. Examinez la cause avant de décider.${translateMainSignal(suffix)}`],
  [/^Forecast conditions go beyond the limits you declared for this departure\.(.*)$/, (_match, suffix) => `Les conditions prévues dépassent les limites que vous avez déclarées pour ce départ.${translateMainSignal(suffix)}`],
  [/^Authority override: bulletin (.+) active during the passage window\. This state overrides the personal-limit summary and does not assert a numeric limit exceedance\.$/, 'Priorité à l’autorité : le bulletin $1 est actif pendant la fenêtre de traversée. Cet état prévaut sur le résumé des limites personnelles et n’affirme aucun dépassement chiffré.'],
  [/^Detected systems \((.+)\): (.+)\. Front-type labels withheld pending corroboration \(§4\.1\)\.$/, (_match, run, systems) => `Systèmes détectés (${run}) : ${translateDetectedSystems(systems)}. Les types de fronts ne sont pas indiqués dans l’attente d’une corroboration (§4.1).`],
  [/^Per-leg conditions evaluated hourly across each leg's ETA occupancy window \(slow\/nominal\/fast scenarios\), course-relative\.$/, 'Conditions de chaque tronçon évaluées heure par heure sur sa fenêtre d’occupation estimée (scénarios lent, nominal et rapide), par rapport à la route.'],
  [/^L\d+ .+ \([\d.]+ nm, [\d.]+°T\): .+$/, (value) => translateProfessionalLeg(value)],
  [/^(All evaluated condition-hours remain below declared thresholds|One or more condition-hours reach ≥75% of a declared limit, or the ensemble scenario fraction is above your declared floor|At least one condition-hour exceeds a declared threshold in the deterministic run|Deterministic model divergence exceeds assessment tolerance within the passage window|Authority override active: an official bulletin covers route zones during the passage window)\.(.*)$/, (_match, assessment, suffix) => `${translateProfessionalAssessment(assessment)}.${translateProfessionalDecisionSuffix(suffix)}`],
  [/^Next (.+) cycle expected ~(.+)\. Model run ids in this analysis are inferred from publication schedules until the prepared-run pipeline provides authoritative cycles\. Agreement between runs is not proof of accuracy\.$/, 'Prochain cycle $1 attendu vers $2. Dans cette analyse, les identifiants de cycles sont déduits des calendriers de publication jusqu’à ce que la chaîne de préparation fournisse les cycles de référence. La concordance entre les cycles ne prouve pas leur exactitude.'],
  [/^Emulated evidence entries: (.+)\. Provider modes are recorded in the snapshot inputs\.$/, 'Entrées probantes simulées : $1. Les modes des fournisseurs sont consignés dans les données d’entrée du briefing.'],
  [/^This briefing does NOT cover: (.+)\. Partly assessed: (.+)\. No warning here does not mean no risk\.$/, (_match, unsupported, partial) => `Ce briefing ne couvre PAS : ${translateCapabilityList(unsupported)}. Évaluation partielle : ${translateCapabilityList(partial)}. L’absence d’alerte ici ne signifie pas l’absence de risque.`],
  [/^This briefing does NOT cover: (.+)\. No warning here does not mean no risk\.$/, (_match, unsupported) => `Ce briefing ne couvre PAS : ${translateCapabilityList(unsupported)}. L’absence d’alerte ici ne signifie pas l’absence de risque.`],
  [/^Unassessed hazard classes: (.+)\. Partial capability coverage: (.+)\. Absence of a flag must not be read as absence of risk \(brief §5\)\.$/, (_match, unsupported, partial) => `Catégories de dangers non évaluées : ${translateCapabilityList(unsupported)}. Couverture partielle des capacités : ${translateCapabilityList(partial)}. L’absence de signalement ne doit pas être interprétée comme une absence de risque (briefing §5).`],
  [/^Unassessed hazard classes: (.+)\. Absence of a flag must not be read as absence of risk \(brief §5\)\.$/, (_match, unsupported) => `Catégories de dangers non évaluées : ${translateCapabilityList(unsupported)}. L’absence de signalement ne doit pas être interprétée comme une absence de risque (briefing §5).`],
  [/^Plan views$/, 'Vues de planification'],
  [/^Brief views$/, 'Vues du briefing'],
  [/^Watch views$/, 'Vues du suivi'],
  [/^Verify views$/, 'Vues de vérification'],
  [/^SNAPSHOT$/, 'BRIEFING'],
  [/^SNAPSHOT /, 'BRIEFING '],
  [/^Start\s*→\s*Finish$/, 'Départ → Arrivée'],
  [/^24-hour clock \(HH:mm\) · your local time · (.+)$/, 'format 24 heures (HH:mm) · votre heure locale · $1'],
  [/^24-hour local time · (.+) · same route, different weather$/, 'heure locale au format 24 heures · $1 · même route, météo différente'],
  [/^24-hour local time · (.+) · each departure sails its own computed route$/, 'heure locale au format 24 heures · $1 · chaque départ suit sa propre route calculée'],
  [/^local time · (.+)$/, 'heure locale · $1'],
  [/^dep (.+) local time · (.+)$/, 'départ $1 heure locale · $2'],
  [/^dep (.+) UTC$/, 'départ $1 UTC'],
  [/^forecast updates ~(.+); check again before you cast off$/, 'mise à jour des prévisions vers $1; vérifiez à nouveau avant d’appareiller'],
  [/^The forecast updates around (.+); check again before you cast off\.$/, 'La prévision est mise à jour vers $1; vérifiez à nouveau avant d’appareiller.'],
  [/^The forecast updates several times a day\. Check again before you cast off\.$/, 'La prévision est mise à jour plusieurs fois par jour. Vérifiez à nouveau avant d’appareiller.'],
  [/^The next model run is expected around (.+) UTC\. Check again then, especially if conditions are close to your limits\.$/, 'Le prochain cycle du modèle est attendu vers $1 UTC. Vérifiez à nouveau à ce moment-là, surtout si les conditions approchent vos limites.'],
  [/^A weather system crosses your passage window$/, 'Un système météo traverse votre fenêtre de passage'],
  [/^The forecast reaches ([\d.]+) (\w+) against your ([\d.]+) (\w+) limit (.+)\.$/, 'La prévision atteint $1 $2, pour une limite fixée à $3 $4, $5.'],
  [/^Strongest (.+)$/, 'Conditions les plus fortes $1'],
  [/^Wind over tide (.+) around (.+) UTC; expect short, steep seas\.$/, 'Vent contre courant $1 vers $2 UTC; attendez-vous à une mer courte et abrupte.'],
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
  [/^gusts up to ([\d.]+) kt; close to your ([\d.]+) kt limit while the low crosses (.+)\.$/, 'rafales jusqu’à $1 nd; proches de votre limite de $2 nd pendant que la dépression traverse $3.'],
  [/^gusts up to ([\d.]+) kt; over your ([\d.]+) kt limit while the low crosses (.+)\.$/, 'rafales jusqu’à $1 nd; au-dessus de votre limite de $2 nd pendant que la dépression traverse $3.'],
  [/^(.+): fresh winds while you are on this stretch \((.+)\)\.(.*)$/, '$1 : vents frais pendant ce tronçon ($2).$3'],
  [/^(.+): strong winds while you are on this stretch \((.+)\)\.(.*)$/, '$1 : vents forts pendant ce tronçon ($2).$3'],
  [/^(.+): light winds while you are on this stretch \((.+)\)\.(.*)$/, '$1 : vents faibles pendant ce tronçon ($2).$3'],
  [/^(.+): moderate winds while you are on this stretch \((.+)\)\.(.*)$/, '$1 : vents modérés pendant ce tronçon ($2).$3'],
  [/^Forecasts update several times a day\. Check again after the next model run \(expected around (.+) UTC\); especially if you are close to your limits\.$/, 'Les prévisions sont mises à jour plusieurs fois par jour. Vérifiez à nouveau après le prochain cycle du modèle (attendu vers $1 UTC), surtout si les conditions sont proches de vos limites.'],
  [/^Conditions along your route: (.+)$/, 'Conditions le long de votre route : $1'],
  [/^(\d+) of (\d+)$/, '$1 sur $2'],
  [/^forecast scenarios exceed (.+); raw fraction \((.+)\), not a calibrated probability$/, 'scénarios de prévision dépassent $1; fraction brute ($2), pas une probabilité étalonnée'],
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

function translateSynopticPosition(position) {
  const positions = {
    'far out in the Atlantic, to the north': 'loin dans l’Atlantique, au nord',
    'far out in the Atlantic, to the south': 'loin dans l’Atlantique, au sud',
    'far out in the Atlantic, at your latitude': 'loin dans l’Atlantique, à votre latitude',
    'west of the approaches, to the north': 'à l’ouest des approches, au nord',
    'west of the approaches, to the south': 'à l’ouest des approches, au sud',
    'west of the approaches, at your latitude': 'à l’ouest des approches, à votre latitude',
    'near your waters, to the north': 'près de votre zone de navigation, au nord',
    'near your waters, to the south': 'près de votre zone de navigation, au sud',
    'near your waters, at your latitude': 'près de votre zone de navigation, à votre latitude',
  };
  return positions[position] ?? position;
}

function translateDetectedSystems(systems) {
  return systems
    .replace(/^lows /, 'dépressions ')
    .replace(/; highs none/, ' ; aucun anticyclone')
    .replace(/; highs /, ' ; anticyclones ')
    .replace(/\bnone\b/g, 'aucun')
    .replace(/\bnear\b/g, 'près de')
    .replace(/, deepening ([\d.]+) hPa\/24h/g, ', se creusant de $1 hPa/24 h')
    .replace(/, filling ([\d.]+) hPa\/24h/g, ', se comblant de $1 hPa/24 h')
    .replace(/, steady/g, ', stable')
    .replace(/, moving ([A-Z]+) ([\d.]+) kt/g, ', se déplaçant vers l’$1 à $2 nd');
}

function translateRouteName(name) {
  return name
    .replace(/\bStart\b/g, 'Départ')
    .replace(/\bFinish\b/g, 'Arrivée')
    .replace(/\bwaypoint (\d+)\b/gi, 'point de route $1');
}

function translateWindStrength(strength) {
  return {
    light: 'vents faibles',
    moderate: 'vents modérés',
    fresh: 'vents frais',
    strong: 'vents forts',
    'near-gale': 'vents proches du grand frais',
    'gale-force': 'vents de force coup de vent',
  }[strength];
}

function translateExceedanceSuffix(suffix) {
  if (!suffix) return '';
  const match = suffix.match(/^ (all (\d+)|(\d+) of (\d+)) forecast scenarios exceed your ([\d.]+) kt (gust|wind) limit around (.+) UTC\.$/i);
  if (!match) return suffix;
  const count = match[2] ? `Les ${match[2]} scénarios de prévision` : `${match[3]} scénarios sur ${match[4]}`;
  const kind = match[6] === 'gust' ? 'rafales' : 'vent';
  return ` ${count} dépassent votre limite de ${kind} de ${match[5]} nd vers ${match[7]} UTC.`;
}

function translateProfessionalLeg(value) {
  const match = value.match(/^(L\d+) (.+) \(([\d.]+) nm, ([\d.]+)°T\): sustained ([\d–.]+) kt(?:, gusts to ([\d.]+) kt)? across the ETA window (.+) UTC\.(.*)$/);
  if (!match) return value;
  let translated = `${match[1]} ${translateRouteName(match[2])} (${match[3]} M, ${match[4]}° vrais) : vent moyen ${match[5]} nd${match[6] ? `, rafales jusqu’à ${match[6]} nd` : ''} sur la fenêtre d’arrivée estimée ${match[7]} UTC.`;
  translated += match[8]
    .replace(/ Seas to ([\d.]+) m significant \(deterministic wave model; no wave ensembles exist\)\./g, ' Mer significative jusqu’à $1 m (modèle de vagues déterministe ; aucun ensemble de vagues).')
    .replace(/ Wind against swell here; expect steeper, more uncomfortable seas\./g, ' Vent contre houle sur ce tronçon : attendez-vous à une mer plus abrupte et inconfortable.')
    .replace(/ Wind-against-swell flagged\./g, ' Vent contre houle signalé.')
    .replace(/ Models diverge on (\d+) h of this leg \(max spread ([\d.]+) kt\); agreement is not proof, divergence says wait for the next run\./g, ' Les modèles divergent pendant $1 h sur ce tronçon (écart maximal de $2 nd) ; la concordance ne constitue pas une preuve et la divergence invite à attendre le prochain cycle.')
    .replace(/ Ensemble \((.+)\): all (\d+) forecast scenarios exceed your ([\d.]+) kt (gust|wind) limit at (.+) \(raw scenario fraction; not a calibrated probability\)\./gi, (_m, model, count, limit, kind, time) => ` Ensemble (${model}) : les ${count} scénarios de prévision dépassent votre limite de ${kind.toLowerCase() === 'gust' ? 'rafales' : 'vent'} de ${limit} nd à ${time} (fraction brute de scénarios, et non probabilité étalonnée).`)
    .replace(/ Ensemble \((.+)\): (\d+) of (\d+) forecast scenarios exceed your ([\d.]+) kt (gust|wind) limit at (.+) \(raw scenario fraction; not a calibrated probability\)\./gi, (_m, model, exceed, total, limit, kind, time) => ` Ensemble (${model}) : ${exceed} scénarios sur ${total} dépassent votre limite de ${kind.toLowerCase() === 'gust' ? 'rafales' : 'vent'} de ${limit} nd à ${time} (fraction brute de scénarios, et non probabilité étalonnée).`);
  return translated;
}

function translateProfessionalAssessment(assessment) {
  return {
    'All evaluated condition-hours remain below declared thresholds': 'Toutes les conditions horaires évaluées restent sous les seuils déclarés',
    'One or more condition-hours reach ≥75% of a declared limit, or the ensemble scenario fraction is above your declared floor': 'Une ou plusieurs conditions horaires atteignent au moins 75 % d’une limite déclarée, ou la fraction de scénarios d’ensemble dépasse votre seuil déclaré',
    'At least one condition-hour exceeds a declared threshold in the deterministic run': 'Au moins une condition horaire dépasse un seuil déclaré dans le cycle déterministe',
    'Deterministic model divergence exceeds assessment tolerance within the passage window': 'La divergence des modèles déterministes dépasse la tolérance d’évaluation pendant la fenêtre de traversée',
    'Authority override active: an official bulletin covers route zones during the passage window': 'Priorité active à l’autorité : un bulletin officiel couvre des zones de la route pendant la fenêtre de traversée',
  }[assessment];
}

function translateProfessionalDecisionSuffix(suffix) {
  return suffix
    .replace(/ Driver: (\S+) on (L\d+) at (\S+); (\d+)\/(\d+) members > ([\d.]+) (\S+)\./g, ' Facteur déterminant : $1 sur $2 à $3; $4 membres sur $5 > $6 $7.')
    .replace(/ Driver: (\S+) on (L\d+) at (\S+); ([\d.]+) (\S+) vs declared ([\d.]+) (\S+)\./g, ' Facteur déterminant : $1 sur $2 à $3; $4 $5 contre une limite déclarée de $6 $7.');
}

function translateMainSignal(suffix) {
  if (!suffix) return '';
  const match = suffix.match(/^ The main signal: (.+) on (.+) around (.+) UTC\.$/);
  if (!match) return suffix;
  return ` Signal principal : ${translateExceedanceClaim(match[1])} sur ${translateRouteName(match[2])} vers ${match[3]} UTC.`;
}

function translateExceedanceClaim(claim) {
  return claim
    .replace(/^gusts up to ([\d.]+) kt; over your ([\d.]+) kt limit$/, 'rafales jusqu’à $1 nd; au-dessus de votre limite de $2 nd')
    .replace(/^gusts up to ([\d.]+) kt; close to your ([\d.]+) kt limit$/, 'rafales jusqu’à $1 nd; proches de votre limite de $2 nd')
    .replace(/^([\d.]+) kt against your ([\d.]+) kt limit$/, '$1 nd pour une limite de $2 nd')
    .replace(/^(all (\d+)|(\d+) of (\d+)) forecast scenarios exceed your ([\d.]+) kt limit$/i, (_match, _count, all, exceed, total, limit) => all
      ? `les ${all} scénarios de prévision dépassent votre limite de ${limit} nd`
      : `${exceed} scénarios sur ${total} dépassent votre limite de ${limit} nd`);
}

function translateCapabilityList(value) {
  return value
    .replace(/official marine warnings \(no feed configured\)/gi, 'alertes marines officielles (aucun flux configuré)')
    .replace(/official marine warnings/gi, 'alertes marines officielles')
    .replace(/tidal currents & gates/gi, 'courants et portes de marée')
    .replace(/waves \(deterministic wave model only; no wave ensemble\)/gi, 'vagues (modèle de vagues déterministe uniquement ; aucun ensemble de vagues)')
    .replace(/visibility_and_convection \(screening signals only \(single model, GFS\); official warnings remain authoritative\)/gi, 'visibilité et convection (signaux de dépistage uniquement, issus d’un seul modèle, GFS ; les alertes officielles restent la référence)')
    .replace(/tidal_currents \(stride-subsampled x(\d+) from native ([\d.]+) deg to ([\d.]+) deg \(target ([\d.]+) deg\); values are exact native cell values, no smoothing\)/gi, 'courants de marée (sous-échantillonnage par pas x$1, de $2° natif à $3°, cible $4° ; valeurs exactes des cellules natives, sans lissage)')
    .replace(/tidal currents \(no prepared current grid\)/gi, 'courants de marée (aucune grille de courants préparée)')
    .replace(/tidal gates & HW\/LW heights \(no tide data\)/gi, 'portes de marée et hauteurs PM/BM (aucune donnée de marée)')
    .replace(/tropical systems/gi, 'systèmes tropicaux')
    .replace(/\bice\b/gi, 'glace')
    .replace(/limited inputs/gi, 'données d’entrée limitées');
}

const FR_FRAGMENTS = [
  [/\bofficial marine warnings \(no feed configured\)/gi, 'alertes marines officielles (aucun flux configuré)'],
  [/\bmoderate winds while you are on this stretch\b/gi, 'vents modérés pendant ce tronçon'],
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
  [/(\d+) NM\b/g, '$1 M'],
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
