import { describe, expect, it } from 'vitest';
import {
	groupBrandDump,
	MAKER_NOTES_SIZE_LIMIT,
	mergeMakerNotes,
	tempExtForMime
} from './exif-makernotes';

/**
 * Pure-shape tests for the maker-notes grouping (multi-brand batch). The
 * live three-brand probes (fuji-sample / Apple.jpg / Canon.jpg) live in
 * verify-media; here we pin the grouping rules, sanitization and the cap.
 */
describe('groupBrandDump', () => {
	it('keeps brand groups and strips their prefixes, with the FujiFilm alias', () => {
		const dump = groupBrandDump({
			'IFD0:Make': 'FUJIFILM',
			'ExifTool:ExifToolVersion': 13.59,
			'System:FileName': 'x.jpg',
			'FujiFilm:FilmMode': 'Classic Chrome',
			'Canon:BulbDuration': 0,
			'Apple:RunTimeValue': 123,
			'XMP-dc:Subject': 'x',
			'Composite:ImageSize': '1x1'
		});
		expect(dump).toEqual({
			fuji: { FilmMode: 'Classic Chrome' },
			canon: { BulbDuration: 0 },
			apple: { RunTimeValue: 123 }
		});
	});

	it('keeps unknown brand groups (data asset) but drops container groups', () => {
		const dump = groupBrandDump({
			'Samsung:MotionPhotoVersion': 1,
			'GCamera:MotionPhoto': 1,
			'QuickTime:Duration': '1s',
			'Keys:ContentIdentifier': 'X',
			'JFIF:JFIFVersion': 1.01,
			'FlashPix:Data07': 'blob',
			'FotoStation:Data08': 'blob'
		});
		expect(dump).toEqual({
			samsung: { MotionPhotoVersion: 1 },
			gcamera: { MotionPhoto: 1 }
		});
	});

	it('serializes dates to ISO strings and drops binary placeholders', () => {
		const dump = groupBrandDump({
			'Apple:RunTimeEpoch': new Date('2026-01-01T00:00:00Z'),
			'Apple:ThumbnailImage': { _ctor: 'BinaryField', bytes: 5133, rawValue: '(Binary data)' }
		});
		expect(dump).toEqual({ apple: { RunTimeEpoch: '2026-01-01T00:00:00.000Z' } });
	});

	it('strips U+0000 from values and keys (jsonb cannot carry it)', () => {
		const dump = groupBrandDump({
			'FujiFilm:Copyright': 'ACME\u0000',
			'FujiFilm:Soft\u0000ware': 1
		});
		expect(dump).toEqual({ fuji: { Copyright: 'ACME', Software: 1 } });
	});

	it('counts non-system unqualified keys into a visible _dropped marker', () => {
		const dump = groupBrandDump({
			SourceFile: 'x.jpg',
			errors: ['x'],
			warnings: [],
			SomeLooseKey: 1,
			'FujiFilm:FilmMode': 'X'
		});
		expect(dump).toEqual({
			fuji: { FilmMode: 'X' },
			_dropped: { unqualifiedKeys: 1 }
		});
	});

	it('excludes every non-brand group in the table (table-driven)', () => {
		const excluded = [
			'SourceFile',
			'errors',
			'warnings',
			'ExifTool',
			'System',
			'File',
			'IFD0',
			'IFD1',
			'ExifIFD',
			'GPS',
			'InteropIFD',
			'Composite',
			'MWG',
			'ICC_Profile',
			'ICC-header',
			'Photoshop',
			'JFIF',
			'PrintIM',
			'FlashPix',
			'FotoStation',
			'QuickTime',
			'Keys',
			'Meta',
			'UserData',
			'ItemList',
			'XML'
		];
		const tags: Record<string, unknown> = {};
		for (const group of excluded) tags[`${group}:SampleTag`] = 'x';
		tags['XMP:Rating'] = 5;
		tags['XMP-dc:Subject'] = 'x';
		expect(groupBrandDump(tags)).toEqual({});
	});

	it('caps oversized dumps with a visible truncation marker', () => {
		const big: Record<string, unknown> = {};
		for (let index = 0; index < 40; index += 1) {
			big[`Apple:Tag${index}`] = 'x'.repeat(10_000);
		}
		const dump = groupBrandDump(big) as Record<string, unknown>;
		const marker = dump._truncated as { droppedTags: number; originalChars: number };
		expect(marker.droppedTags).toBeGreaterThan(0);
		expect(marker.originalChars).toBeGreaterThan(MAKER_NOTES_SIZE_LIMIT);
		expect(JSON.stringify(dump).length).toBeLessThanOrEqual(MAKER_NOTES_SIZE_LIMIT + 200);
	});
});

describe('mergeMakerNotes / tempExtForMime', () => {
	it('merges under makerNotes and passes exif through when empty', () => {
		expect(mergeMakerNotes({ ISO: 400 }, { fuji: { FilmMode: 'X' } })).toEqual({
			ISO: 400,
			makerNotes: { fuji: { FilmMode: 'X' } }
		});
		expect(mergeMakerNotes({ ISO: 400 }, null)).toEqual({ ISO: 400 });
		expect(mergeMakerNotes(null, { fuji: { FilmMode: 'X' } })).toEqual({
			makerNotes: { fuji: { FilmMode: 'X' } }
		});
	});

	it('maps sniffed mime types to safe extensions', () => {
		expect(tempExtForMime('image/jpeg')).toBe('jpg');
		expect(tempExtForMime('image/heic')).toBe('heic');
		expect(tempExtForMime('application/pdf')).toBe('bin');
	});
});
