/**
 * Client-side audio/video extension classification for the streaming media
 * viewers. Video/audio play through the dedicated `/sidebar/video` route,
 * which supports HTTP Range (206) and is NOT capped by the 20MB `mediaLimit`
 * of the buffered `/sidebar/file` route — so large files stream and the
 * progress bar can be scrubbed. The host's `MEDIA_TYPES` table carries the
 * matching content types (mirror of this list; keep the two in sync).
 *
 * This module is dependency-free and lives in the core bundle (the viewer
 * descriptor and the center view both read it).
 */

/** Video container extensions (browser decode of the inner codec varies). */
export const VIDEO_EXTS = [
  'mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv', 'avi', 'mpg', 'mpeg', 'wmv', 'flv', '3gp',
] as const

/** Audio extensions (rendered as an <audio> element instead of <video>). */
export const AUDIO_EXTS = [
  'mp3', 'm4a', 'wav', 'ogg', 'oga', 'flac', 'aac', 'opus',
] as const

/** Every extension the streaming media viewer claims. */
export const MEDIA_EXTS = [...VIDEO_EXTS, ...AUDIO_EXTS] as const

export const isVideoExt = (ext: string): boolean => (VIDEO_EXTS as readonly string[]).includes(ext)

export const isAudioExt = (ext: string): boolean => (AUDIO_EXTS as readonly string[]).includes(ext)

export const isMediaExt = (ext: string): boolean => isVideoExt(ext) || isAudioExt(ext)
