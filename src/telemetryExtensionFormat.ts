import { 
  ResponsePath,
  responsePathAsArray
} from 'graphql';

import { 
  TelemetryCollector,
  ResolverCall,
  HighResolutionTime
} from './instrumentation';

export function formatTelemetryData(telemetryCollector: TelemetryCollector) {
  return {
    "version": 1,
    "startTime": telemetryCollector.startWallTime.toISOString(),
    "endTime": telemetryCollector.endWallTime.toISOString(),
    "duration": durationHrTimeToNanos(telemetryCollector.duration),
    "execution": {
      "resolvers": formatResolverCalls(telemetryCollector.resolverCalls)
    }
  }
}

export interface ResolverNode {
  __span?: Span;
  // String index type should be ResolverNode instead of any, 
  // but you can't express this because it conflicts with __span
  [key: string]: any;
}

export interface Span {
  startOffset: number;
  endOffset: number;
}

function formatResolverCalls(resolverCalls: ResolverCall[]) {
  let root: ResolverNode = {}

  resolverCalls.forEach(resolverCall => {
    const path = resolverCall.path;
    if (!path) return;

    let parent = responsePathAsArray(path.prev)
      .reduce(
        (node, segment) => {
          let child: ResolverNode = node[segment];
          if (!child) {
            child = {};
            node[segment] = child;
          }
          return child;
        },
        root
      );

    parent[path.key] = {
      __span: {
        startOffset: durationHrTimeToNanos(resolverCall.startOffset),
        endOffset: resolverCall.endOffset ? durationHrTimeToNanos(resolverCall.endOffset) : undefined
      }
    };
  });

  return root;
}

// Converts an hrtime array (as returned from process.hrtime) to nanoseconds.
//
// ONLY CALL THIS ON VALUES REPRESENTING DELTAS, NOT ON THE RAW RETURN VALUE
// FROM process.hrtime() WITH NO ARGUMENTS.
//
// The entire point of the hrtime data structure is that the JavaScript Number
// type can't represent all int64 values without loss of precision:
// Number.MAX_SAFE_INTEGER nanoseconds is about 104 days. Calling this function
// on a duration that represents a value less than 104 days is fine. Calling
// this function on an absolute time (which is generally roughly time since
// system boot) is not a good idea.
function durationHrTimeToNanos(hrtime: HighResolutionTime) {
  return (hrtime[0] * 1e9) + hrtime[1];
}
