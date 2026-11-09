/**
 * Unadopted-summary retention, shared by the manual service (web) and the
 * ai.summarize scanner (plain-Node job drain - this module must stay free of
 * $lib/$env imports so both runtimes can load it).
 */
export const SUMMARY_KEEP_UNADOPTED = 5;
