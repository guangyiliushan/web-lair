import { describe, expect, it } from 'vitest';
import { parseAmzDate, signRequest, type SigV4Request } from './signature';

/**
 * Locked against the official aws-sig-v4 test suite (Apache-2.0; saibotsivad
 * mirror). Each case pins all three levels of the algorithm: canonical
 * request, string to sign, and the Authorization header.
 *
 * Deliberately excluded / adjusted:
 * - normalize-path cases (`get-relative`, `get-slash*`): the generic SigV4
 *   rules normalize dot segments, while S3 signs the path exactly as sent.
 * - `post-x-www-form-urlencoded`: the suite's displayed creq includes
 *   `content-length`, but its sts/authz are computed WITHOUT it (clients do
 *   not sign a content-length they do not control). sts/authz are locked as
 *   published; the canonical request is reconstructed to match.
 * - `post-x-www-form-urlencoded-parameters`: excluded — its sts/authz match
 *   no consistent canonicalization (verified by brute force).
 */

interface SuiteVector {
	name: string;
	method: string;
	path: string;
	query: string;
	/** Header pairs as sent; X-Amz-Date is re-derived by the signer from `date`. */
	headers: Array<[string, string]>;
	payloadHash: string;
	creq: string;
	sts: string;
	authz: string;
}

const SUITE = {
	service: 'service',
	region: 'us-east-1',
	accessKeyId: 'AKIDEXAMPLE',
	secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
	amzDate: '20150830T123600Z'
} as const;

const VECTORS: SuiteVector[] = [
	{
		name: 'get-vanilla',
		method: 'GET',
		path: '/',
		query: '',
		headers: [['Host', 'example.amazonaws.com']],
		payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		creq: 'GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		sts: 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63',
		authz:
			'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
	},
	{
		name: 'get-header-key-duplicate',
		method: 'GET',
		path: '/',
		query: '',
		headers: [
			['Host', 'example.amazonaws.com'],
			['My-Header1', 'value2'],
			['My-Header1', 'value2'],
			['My-Header1', 'value1']
		],
		payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		creq: 'GET\n/\n\nhost:example.amazonaws.com\nmy-header1:value2,value2,value1\nx-amz-date:20150830T123600Z\n\nhost;my-header1;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		sts: 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\ndc7f04a3abfde8d472b0ab1a418b741b7c67174dad1551b4117b15527fbe966c',
		authz:
			'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;my-header1;x-amz-date, Signature=c9d5ea9f3f72853aea855b47ea873832890dbdd183b4468f858259531a5138ea'
	},
	{
		name: 'get-header-value-trim',
		method: 'GET',
		path: '/',
		query: '',
		headers: [
			['Host', 'example.amazonaws.com'],
			['My-Header1', 'value1'],
			['My-Header2', '"a   b   c"']
		],
		payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		creq: 'GET\n/\n\nhost:example.amazonaws.com\nmy-header1:value1\nmy-header2:"a b c"\nx-amz-date:20150830T123600Z\n\nhost;my-header1;my-header2;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		sts: 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\na726db9b0df21c14f559d0a978e563112acb1b9e05476f0a6a1c7d68f28605c7',
		authz:
			'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;my-header1;my-header2;x-amz-date, Signature=acc3ed3afb60bb290fc8d2dd0098b9911fcaa05412b367055dee359757a9c736'
	},
	{
		name: 'get-vanilla-query-order-key-case',
		method: 'GET',
		path: '/',
		query: 'Param2=value2&Param1=value1',
		headers: [['Host', 'example.amazonaws.com']],
		payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		creq: 'GET\n/\nParam1=value1&Param2=value2\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		sts: 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n816cd5b414d056048ba4f7c5386d6e0533120fb1fcfa93762cf0fc39e2cf19e0',
		authz:
			'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500'
	},
	{
		name: 'get-vanilla-utf8-query',
		method: 'GET',
		path: '/',
		query: '\u1234=bar',
		headers: [['Host', 'example.amazonaws.com']],
		payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		creq: 'GET\n/\n%E1%88%B4=bar\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		sts: 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\neb30c5bed55734080471a834cc727ae56beb50e5f39d1bff6d0d38cb192a7073',
		authz:
			'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=2cdec8eed098649ff3a119c94853b13c643bcf08f8b0a1d91e12c9027818dd04'
	},
	{
		name: 'post-x-www-form-urlencoded',
		method: 'POST',
		path: '/',
		query: '',
		headers: [
			['Content-Type', 'application/x-www-form-urlencoded'],
			['Host', 'example.amazonaws.com']
		],
		payloadHash: '9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e',
		creq: 'POST\n/\n\ncontent-type:application/x-www-form-urlencoded\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\ncontent-type;host;x-amz-date\n9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e',
		sts: 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n42a5e5bb34198acb3e84da4f085bb7927f2bc277ca766e6d19c73c2154021281',
		authz:
			'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a'
	}
];

describe('signature (aws-sig-v4 test suite vectors)', () => {
	for (const vector of VECTORS) {
		it(vector.name, () => {
			const request: SigV4Request = {
				method: vector.method,
				canonicalUri: vector.path,
				query: vector.query,
				headers: vector.headers,
				payloadHash: vector.payloadHash,
				region: SUITE.region,
				service: SUITE.service,
				date: parseAmzDate(SUITE.amzDate)
			};
			const signed = signRequest(request, {
				accessKeyId: SUITE.accessKeyId,
				secretAccessKey: SUITE.secretAccessKey
			});

			expect(signed.canonicalRequest).toBe(vector.creq);
			expect(signed.stringToSign).toBe(vector.sts);
			expect(signed.authorization).toBe(vector.authz);
		});
	}
});
