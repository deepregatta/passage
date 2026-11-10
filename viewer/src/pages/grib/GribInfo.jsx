import { GRIB_INFO_BLOCKS } from '../../gribContent.js';
import { privacyPath } from '../../lib/routes.js';

// Renderers by block type (gribContent.js). The text of every block is a key in
// the i18n.js catalogue, so French needs no markup of its own.
const BLOCKS = {
  h2: ({ text }) => <h2 className="pt-3 font-instrument font-semibold uppercase tracking-wider">{text}</h2>,
  h3: ({ text }) => <h3 className="eyebrow pt-1">{text}</h3>,
  p: ({ text }) => <p>{text}</p>,
  ul: ({ items }) => (
    <ul className="list-disc space-y-1.5 pl-5">
      {items.map((item) => <li key={item}>{item}</li>)}
    </ul>
  ),
  privacy: ({ text, language }) => <p><a className="text-event underline underline-offset-4 hover:no-underline" href={privacyPath(language)}>{text}</a></p>,
};

/** What a sailor wants to know before downloading: models, coverage, contents,
 * programs and limits. Sits below the tool; the same text is in the static HTML
 * of /grib and /fr/grib (scripts/prerender-fr.mjs), so crawlers read it too. */
export default function GribInfo({ language }) {
  return (
    <section aria-label="About the GRIB files" className="mt-8 max-w-3xl space-y-3 font-sans text-sm text-ink">
      {GRIB_INFO_BLOCKS.map((block, index) => {
        const Block = BLOCKS[block.type];
        return <Block key={index} {...block} language={language} />;
      })}
    </section>
  );
}
