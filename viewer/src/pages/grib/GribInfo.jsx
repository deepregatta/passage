import { GRIB_INFO_BLOCKS } from '../../gribContent.js';
import { privacyPath } from '../../lib/routes.js';

// Renderers by block type (gribContent.js). The text of every block is a key in
// the i18n.js catalogue, so French needs no markup of its own.
const BLOCKS = {
  h3: ({ text }) => <h3 className="eyebrow text-[12px]! pt-1">{text}</h3>,
  p: ({ text }) => <p>{text}</p>,
  ul: ({ items }) => (
    <ul className="list-disc space-y-1.5 pl-5">
      {items.map((item) => <li key={item}>{item}</li>)}
    </ul>
  ),
  privacy: ({ text, language }) => <p><a className="inline-flex min-h-11 md:min-h-0 items-center text-event underline underline-offset-4 hover:no-underline" href={privacyPath(language)}>{text}</a></p>,
};

// Open on arrival: what a sailor checks most before opening a file.
const OPEN = new Set(['What is in the files', 'Opening the files in your software']);

/** The blocks grouped under their h2, one collapsible section each. */
function sections() {
  const groups = [];
  for (const block of GRIB_INFO_BLOCKS) {
    if (block.type === 'h2') groups.push({ title: block.text, blocks: [] });
    else groups.at(-1).blocks.push(block);
  }
  return groups;
}

/** What a sailor wants to know before downloading: models, coverage, contents,
 * programs and limits. Sits below the tool as native <details> sections, each
 * heading in its summary; closed sections stay in the DOM, and the same text is
 * in the static HTML of /grib and /fr/grib (scripts/prerender-fr.mjs), so
 * crawlers read all of it. */
export default function GribInfo({ language }) {
  return (
    <section aria-label="About the GRIB files" className="mt-8 max-w-3xl font-sans text-sm text-ink divide-y-legacy divide-ink/30 border-y border-ink/30">
      {sections().map(({ title, blocks }) => (
        <details key={title} open={OPEN.has(title)} className="group">
          <summary className="cursor-pointer list-none min-h-11 flex items-center gap-2 py-2 [&::-webkit-details-marker]:hidden">
            <span aria-hidden="true" className="inline-block w-3 text-ink-soft transition-transform group-open:rotate-90">▸</span>
            <h2 className="font-instrument font-semibold uppercase tracking-wider">{title}</h2>
          </summary>
          <div className="space-y-3 pb-4 pl-5">
            {blocks.map((block, index) => {
              const Block = BLOCKS[block.type];
              return <Block key={index} {...block} language={language} />;
            })}
          </div>
        </details>
      ))}
    </section>
  );
}
