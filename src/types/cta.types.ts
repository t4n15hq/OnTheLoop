// CTA Train Tracker API Response Types
export interface CTATrainArrival {
  staId: string;        // Station ID
  stpId: string;        // Stop ID
  staNm: string;        // Station name
  stpDe: string;        // Stop description
  rn: string;           // Run number
  rt: string;           // Route (line color)
  destSt: string;       // Destination station ID
  destNm: string;       // Destination name
  trDr: string;         // Train direction
  prdt: string;         // Prediction generation time
  arrT: string;         // Arrival time
  isApp: string;        // Is approaching (1 or 0)
  isSch: string;        // Is scheduled (1 or 0)
  isDly: string;        // Is delayed (1 or 0)
  isFlt: string;        // Is fault (1 or 0)
  flags: string;        // Flags
  lat: string;          // Latitude
  lon: string;          // Longitude
  heading: string;      // Heading
}

export interface CTATrainResponse {
  ctatt: {
    tmst: string;
    errCd: string;
    errNm: string;
    eta?: CTATrainArrival[];
  };
}

// CTA Bus Tracker API Response Types
export interface CTABusPrediction {
  tmstmp: string;       // Timestamp
  typ: string;          // Type (A for arrival, D for departure)
  stpnm: string;        // Stop name
  stpid: string;        // Stop ID
  vid: string;          // Vehicle ID
  dstp: number;         // Distance to stop
  rt: string;           // Route
  rtdd: string;         // Route direction
  rtdir: string;        // Route direction description
  des: string;          // Destination
  prdtm: string;        // Predicted time
  tablockid: string;    // TA block ID
  tatripid: string;     // TA trip ID
  dly: boolean;         // Is delayed
  prdctdn: string;      // Prediction countdown (minutes)
  zone: string;         // Zone
}

export interface CTABusResponse {
  'bustime-response': {
    prd?: CTABusPrediction[];
    error?: Array<{
      msg: string;
      stpid?: string;
    }>;
  };
}

// Formatted response types for our app
export interface FormattedArrival {
  routeName: string;
  destination: string;
  arrivalTime: Date;
  minutesAway: number;
  isApproaching: boolean;
  isDelayed: boolean;
}
