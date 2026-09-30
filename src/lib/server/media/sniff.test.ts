import { describe, expect, it } from 'vitest';
import { sniffUpload } from './sniff';

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
const bytes = (...parts: number[][]) => Uint8Array.from(parts.flat());

const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], [0, 0, 0, 0]);
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0]);
const GIF = bytes(ascii('GIF89a'));
const WEBP = bytes(ascii('RIFF'), [0, 0, 0, 0], ascii('WEBP'));
const bmff = (brand: string) => bytes([0, 0, 0, 0x1c], ascii('ftyp'), ascii(brand));
const PDF = bytes(ascii('%PDF-1.7'));
const ZIP = bytes(ascii('PK'), [3, 4]);
const ZIP_EMPTY = bytes(ascii('PK'), [5, 6]);
const TIFF = bytes([0x49, 0x49, 0x2a, 0x00], [0, 0]);
const TIFF_BE = bytes([0x4d, 0x4d, 0x00, 0x2a], [0, 0]);

describe('sniffUpload (plan §4.2 whitelist)', () => {
	it('accepts each whitelisted family when extension and magic agree', () => {
		expect(sniffUpload('photo.jpg', JPEG)).toEqual({
			kind: 'image',
			ext: 'jpg',
			mimeType: 'image/jpeg'
		});
		expect(sniffUpload('photo.JPEG', JPEG)).toEqual({
			kind: 'image',
			ext: 'jpeg',
			mimeType: 'image/jpeg'
		});
		expect(sniffUpload('image.png', PNG)).toEqual({
			kind: 'image',
			ext: 'png',
			mimeType: 'image/png'
		});
		expect(sniffUpload('fun.gif', GIF)).toEqual({
			kind: 'image',
			ext: 'gif',
			mimeType: 'image/gif'
		});
		expect(sniffUpload('old.gif', bytes(ascii('GIF87a')))).toEqual({
			kind: 'image',
			ext: 'gif',
			mimeType: 'image/gif'
		});
		expect(sniffUpload('shot.webp', WEBP)).toEqual({
			kind: 'image',
			ext: 'webp',
			mimeType: 'image/webp'
		});
		expect(sniffUpload('shot.avif', bmff('avif'))).toEqual({
			kind: 'image',
			ext: 'avif',
			mimeType: 'image/avif'
		});
		expect(sniffUpload('shot.heic', bmff('heic'))).toEqual({
			kind: 'image',
			ext: 'heic',
			mimeType: 'image/heic'
		});
		expect(sniffUpload('shot.heif', bmff('mif1'))).toEqual({
			kind: 'image',
			ext: 'heif',
			mimeType: 'image/heif'
		});
		expect(sniffUpload('scan.tif', TIFF)).toEqual({
			kind: 'image',
			ext: 'tif',
			mimeType: 'image/tiff'
		});
		expect(sniffUpload('scan.tiff', TIFF_BE)).toEqual({
			kind: 'image',
			ext: 'tiff',
			mimeType: 'image/tiff'
		});
		expect(sniffUpload('doc.pdf', PDF)).toEqual({
			kind: 'file',
			ext: 'pdf',
			mimeType: 'application/pdf'
		});
		expect(sniffUpload('archive.zip', ZIP)).toEqual({
			kind: 'file',
			ext: 'zip',
			mimeType: 'application/zip'
		});
		expect(sniffUpload('empty.zip', ZIP_EMPTY)).toEqual({
			kind: 'file',
			ext: 'zip',
			mimeType: 'application/zip'
		});
		expect(sniffUpload('notes.md', bytes(ascii('# hello')))).toEqual({
			kind: 'file',
			ext: 'md',
			mimeType: 'text/markdown'
		});
		expect(sniffUpload('readme.txt', bytes(ascii('hi there')))).toEqual({
			kind: 'file',
			ext: 'txt',
			mimeType: 'text/plain'
		});
	});

	it('rejects when the extension and the content magic disagree', () => {
		expect(sniffUpload('fake.png', JPEG)).toBeNull();
		expect(sniffUpload('fake.jpg', PNG)).toBeNull();
		expect(sniffUpload('fake.pdf', JPEG)).toBeNull();
		expect(sniffUpload('sneaky.txt', PNG)).toBeNull(); // binary content in a text extension
		expect(sniffUpload('shot.avif', bmff('heic'))).toBeNull();
		expect(sniffUpload('fake.tiff', PNG)).toBeNull();
	});

	it('rejects missing extensions, empty files and unknown types', () => {
		expect(sniffUpload('photo', JPEG)).toBeNull();
		expect(sniffUpload('.jpg', JPEG)).toBeNull();
		expect(sniffUpload('x.jpg', new Uint8Array())).toBeNull();
		expect(sniffUpload('payload.exe', bytes(ascii('MZ')))).toBeNull();
	});

	it('rejects text carrying NUL bytes (binary disguised as text)', () => {
		expect(sniffUpload('evil.txt', bytes(ascii('ab'), [0x00], ascii('cd')))).toBeNull();
		expect(sniffUpload('fine.txt', bytes(ascii('数据 ok'), [0xe6]))).not.toBeNull();
	});
});
