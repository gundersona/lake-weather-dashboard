// Shared configuration: US states and weather variables.
"use strict";

/** All 50 US states as {code, name}. */
const STATES = [
  { code: "AL", name: "Alabama" }, { code: "AK", name: "Alaska" },
  { code: "AZ", name: "Arizona" }, { code: "AR", name: "Arkansas" },
  { code: "CA", name: "California" }, { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" }, { code: "DE", name: "Delaware" },
  { code: "FL", name: "Florida" }, { code: "GA", name: "Georgia" },
  { code: "HI", name: "Hawaii" }, { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" }, { code: "IN", name: "Indiana" },
  { code: "IA", name: "Iowa" }, { code: "KS", name: "Kansas" },
  { code: "KY", name: "Kentucky" }, { code: "LA", name: "Louisiana" },
  { code: "ME", name: "Maine" }, { code: "MD", name: "Maryland" },
  { code: "MA", name: "Massachusetts" }, { code: "MI", name: "Michigan" },
  { code: "MN", name: "Minnesota" }, { code: "MS", name: "Mississippi" },
  { code: "MO", name: "Missouri" }, { code: "MT", name: "Montana" },
  { code: "NE", name: "Nebraska" }, { code: "NV", name: "Nevada" },
  { code: "NH", name: "New Hampshire" }, { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" }, { code: "NY", name: "New York" },
  { code: "NC", name: "North Carolina" }, { code: "ND", name: "North Dakota" },
  { code: "OH", name: "Ohio" }, { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" }, { code: "PA", name: "Pennsylvania" },
  { code: "RI", name: "Rhode Island" }, { code: "SC", name: "South Carolina" },
  { code: "SD", name: "South Dakota" }, { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" }, { code: "UT", name: "Utah" },
  { code: "VT", name: "Vermont" }, { code: "VA", name: "Virginia" },
  { code: "WA", name: "Washington" }, { code: "WV", name: "West Virginia" },
  { code: "WI", name: "Wisconsin" }, { code: "WY", name: "Wyoming" },
];

/**
 * Weather variables shown in the dashboard.
 * key: Open-Meteo hourly parameter name (also used as checkbox data-var).
 * stats: which aggregations are computed for this variable.
 * color: chart color.
 */
const VARIABLES = [
  { key: "temperature_2m", label: "Temperature", unit: "\u00B0F", param: "temperature_2m", stats: ["mean", "min", "max"], color: "#e74c3c" },
  { key: "relative_humidity_2m", label: "Humidity", unit: "%", param: "relative_humidity_2m", stats: ["mean", "min", "max"], color: "#3498db" },
  { key: "surface_pressure", label: "Pressure", unit: "hPa", param: "surface_pressure", stats: ["mean", "min", "max"], color: "#9b59b6" },
  { key: "precipitation", label: "Precipitation", unit: "in", param: "precipitation", stats: ["total"], color: "#2ecc71" },
  { key: "wind_speed_10m", label: "Wind speed", unit: "mph", param: "wind_speed_10m", stats: ["mean", "max"], color: "#f39c12" },
  { key: "wind_direction_10m", label: "Wind direction", unit: "\u00B0", param: "wind_direction_10m", stats: ["prevailing"], color: "#7f8c8d" },
];
