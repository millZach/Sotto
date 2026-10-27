/**
 * Words a part of Settings keeps to show later, such as a notice or an error (ADR-0123): a message, read in the
 * interface language each time it is shown, so a change of language reaches it too, or text someone else wrote, such as
 * a host's error, shown as written. One implementation serves Settings and the Threads page (agents/interfaceWords.ts).
 */
export { shownWords, type LaterWords } from '../../agents/interfaceWords'
