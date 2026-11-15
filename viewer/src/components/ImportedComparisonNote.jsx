/** Either check of a comparison was imported from a file: it compares a result this browser did not compute. */
export default function ImportedComparisonNote() {
  return <span data-testid="imported-comparison" className="block basis-full font-sans text-[13px] text-ink-soft">This comparison uses a check imported from a file, which was not recomputed here.</span>;
}
