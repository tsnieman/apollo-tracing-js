import * as fs from 'fs';
import * as path from 'path';

import {
  encodeCompactResolverCalls,
  decodeCompactResolverCalls,
  formatResolverCalls,
} from '../telemetryExtensionFormat'

describe('GraphQL Telemetry extension format', () => {
  ['githunt', 'starwars'].forEach(fixtureName => {
    test(`should encode and decode ${fixtureName} resolver calls`, () => {
      const resolverCalls = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, 'fixtures', `${fixtureName}.json`), 'utf-8')
      ).resolvers;

      const encodedResolverCalls = JSON.parse(JSON.stringify(encodeCompactResolverCalls(resolverCalls)));

      const decodedResolverCalls = decodeCompactResolverCalls(encodedResolverCalls);

      const formattedResolverCalls = formatResolverCalls(resolverCalls);
      decodedResolverCalls.sort(pathCompare);
      formattedResolverCalls.sort(pathCompare);

      expect(decodedResolverCalls).toEqual(formattedResolverCalls);
    });
  });
});

function pathCompare(a, b) {
  return a.path.join('.').localeCompare(b.path.join('.'));
}