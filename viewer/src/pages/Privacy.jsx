import { useApp } from '../stores/appStore.js';
import { PlanBackLink } from '../components/BackLink.jsx';
import { CONTACT_EMAIL, PRIVACY_BLOCKS, fullPolicyUrl } from '../privacyContent.js';

// Renderers by block type (privacyContent.js). The text of every block is a key in
// the i18n.js catalogue, so French needs no markup of its own.
const BLOCKS = {
  h1: ({ text }) => <h1 className="font-chart text-3xl">{text}</h1>,
  h2: ({ text }) => <h2 className="pt-3 font-instrument font-semibold uppercase tracking-wider">{text}</h2>,
  p: ({ text }) => <p>{text}</p>,
  ul: ({ items }) => (
    <ul className="list-disc space-y-1.5 pl-5">
      {items.map((item) => <li key={item}>{item}</li>)}
    </ul>
  ),
  contact: ({ text }) => (
    <p>{text} <a className="inline-flex min-h-11 items-center text-event underline underline-offset-4 hover:no-underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></p>
  ),
  link: ({ text, language }) => (
    <p><a className="inline-flex min-h-11 items-center text-event underline underline-offset-4 hover:no-underline" href={fullPolicyUrl(language)}>{text}</a></p>
  ),
};

/** What Passage does with personal data, also prerendered for /privacy and
 * /fr/privacy by scripts/prerender-fr.mjs from the same blocks. */
export default function Privacy() {
  const language = useApp((state) => state.language);
  return (
    <article className="px-4 sm:px-6 py-5 max-w-3xl space-y-3 font-sans text-sm text-ink">
      <PlanBackLink>Back to Plan</PlanBackLink>
      {PRIVACY_BLOCKS.map((block, index) => {
        const Block = BLOCKS[block.type];
        return <Block key={index} {...block} language={language} />;
      })}
    </article>
  );
}
