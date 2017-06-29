import { 
  ResponsePath,
  responsePathAsArray
} from 'graphql';

import { 
  TelemetryCollector,
  ResolverCall,
  HighResolutionTime
} from './instrumentation';

export function formatTelemetryData(telemetryCollector: TelemetryCollector): any {
  return {
    "version": 1,
    "startTime": telemetryCollector.startWallTime.toISOString(),
    "endTime": telemetryCollector.endWallTime.toISOString(),
    "duration": durationHrTimeToNanos(telemetryCollector.duration),
    "execution": {
      "resolvers": telemetryCollector.resolverCalls.map(resolverCall => {
        return {
          path: responsePathAsArray(resolverCall.path),
          fieldName: resolverCall.fieldName,
          parentType: resolverCall.parentType,
          returnType: resolverCall.returnType,
          startOffset: durationHrTimeToNanos(resolverCall.startOffset),
          endOffset: resolverCall.endOffset ? durationHrTimeToNanos(resolverCall.endOffset) : undefined
        }
      })
    }
  }
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
