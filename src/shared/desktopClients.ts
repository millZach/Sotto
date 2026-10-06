/**
 * The record of which paired clients are desktops (ADR-0053): a JSON array of client IDs in a host's data folder. The
 * launch script adds a desktop to it over SSH, and the host reads it and takes revoked clients out, so both take its
 * name and bounds from here.
 */
export const DESKTOP_CLIENTS_FILE = 'desktop-clients.json'
/** The longest client ID the record holds, the same as a paired client's. */
export const DESKTOP_CLIENT_ID_MAX = 512
/** The most desktops the record holds; the launch script keeps the newest. */
export const DESKTOP_CLIENTS_MAX = 1000
