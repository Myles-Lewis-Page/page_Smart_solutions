'use strict';
// Starting price list (effective 11/6/2026). Edit prices in the app after first run.
// This file only seeds an empty database.
const SERVICES = [
  // Hourly Service
  { category: 'Hourly Service', name: 'General troubleshooting & diagnostics', info: 'PC, laptop, printer, peripherals', billing: 'Hourly', price: 75 },
  { category: 'Hourly Service', name: 'Virus / malware removal', info: 'Billed hourly, not per device', billing: 'Hourly', price: 75 },
  { category: 'Hourly Service', name: 'Data backup & transfer', info: 'Old device to new, cloud setup', billing: 'Hourly', price: 75 },
  { category: 'Hourly Service', name: 'Software install & configuration', info: 'OS, applications, updates', billing: 'Hourly', price: 75 },
  { category: 'Hourly Service', name: 'Remote support', info: 'No travel charge', billing: 'Hourly', price: 60 },
  { category: 'Hourly Service', name: 'On-call / emergency same-day visit', info: 'Subject to availability, travel billed separately', billing: 'Hourly', price: 100 },

  // Custom PC Builds
  { category: 'Custom PC Builds', name: 'Parts recommendation list', info: 'Curated parts list matched to your budget and use case', billing: 'Flat', price: 35 },
  { category: 'Custom PC Builds', name: 'PC build (labor only)', info: 'Client-supplied parts, full assembly, cabling, OS install', billing: 'Flat', price: 125 },
  { category: 'Custom PC Builds', name: 'Parts purchased through us', info: '$125 build fee plus 10% of parts cost', billing: 'Flat', price: 125 },

  // PC Upgrades & Tune-ups
  { category: 'PC Upgrades & Tune-ups', name: 'PC upgrade (RAM, storage)', info: 'Per component installed', billing: 'Device', price: 35 },
  { category: 'PC Upgrades & Tune-ups', name: 'PC upgrade (GPU, cooling, power supply)', info: 'Per component installed', billing: 'Device', price: 60 },
  { category: 'PC Upgrades & Tune-ups', name: 'Full tune-up / cleanup', info: 'Software cleanup, updates, optimization', billing: 'Flat', price: 85 },
  { category: 'PC Upgrades & Tune-ups', name: 'New PC setup', info: 'Out-of-box setup, account migration, software', billing: 'Flat', price: 100 },

  // Networking & Wi-Fi
  { category: 'Networking & Wi-Fi', name: 'Basic router / Wi-Fi setup', info: 'Single router or mesh point', billing: 'Flat', price: 100 },
  { category: 'Networking & Wi-Fi', name: 'Whole-home mesh network', info: 'Up to 3 nodes, placement and testing included', billing: 'Flat', price: 175 },
  { category: 'Networking & Wi-Fi', name: 'Whole-home mesh network (extra nodes)', info: 'Each node after 3', billing: 'Device', price: 35 },
  { category: 'Networking & Wi-Fi', name: 'Network troubleshooting', info: 'Connectivity, speed, dead zones', billing: 'Hourly', price: 75 },
  { category: 'Networking & Wi-Fi', name: 'Network design & advanced configuration', info: 'VLANs, guest networks, security, wiring plans', billing: 'Hourly', price: 95 },
  { category: 'Networking & Wi-Fi', name: 'Small business network setup', info: 'Final quote after a site visit', billing: 'Custom', price: 300, price_label: 'Starting at' },

  // Smart Home
  { category: 'Smart Home', name: 'Smart hub setup', info: 'Apple Home, Google Home, or similar', billing: 'Device', price: 65 },
  { category: 'Smart Home', name: 'Smart lighting', info: 'Per device, includes app pairing, $40 minimum per visit', billing: 'Device', price: 10 },
  { category: 'Smart Home', name: 'Smart lock setup', info: 'Per lock, includes app setup and testing', billing: 'Device', price: 45 },
  { category: 'Smart Home', name: 'Smart thermostat install', info: 'Per unit, wiring problems billed hourly on top', billing: 'Device', price: 60 },
  { category: 'Smart Home', name: 'Other smart devices', info: 'Cameras, doorbells, plugs, sensors', billing: 'Device', price: 30 },
  { category: 'Smart Home', name: 'Whole-home smart setup', info: 'Bundled hub, lighting, and locks (3+ devices)', billing: 'Custom', price: 200, price_label: 'Starting at' },

  // Fees & Policies (travel is calculated from Settings)
  { category: 'Fees & Policies', name: 'Evening / weekend visit', info: 'Added to the visit total', billing: 'Flat', price: 25 },
  { category: 'Fees & Policies', name: 'Late cancellation / no-show', info: 'Less than 24 hours notice', billing: 'Flat', price: 40 },
  { category: 'Fees & Policies', name: 'Parts & hardware', info: 'Billed at cost, client may buy directly', billing: 'Custom', price: null, price_label: 'At cost' },
];

module.exports = { SERVICES };
