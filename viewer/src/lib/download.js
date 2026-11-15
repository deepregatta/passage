/**
 * Start the browser download of a prepared file ({ url, name }): a Blob or
 * object URL and the file name. Shared by the GRIB page (lib/gribExport.js)
 * and the check-file export (lib/checkFile.js); nothing leaves the device.
 */
export function saveFile(file) {
  const link = document.createElement('a');
  link.href = file.url;
  link.download = file.name;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
}
