# Product tour

An interactive tour which helps onboard new users to Mautic

## Installation

Reload plugins on the plugin page, and the tours will be available. 

## Development

This plugin leverages the [shepherdjs](https://www.shepherdjs.dev/) library to add tours to Mautic. 
Tours are created inside the `Assets/js/tours.js` file.

The selector check statically verifies tour selectors against Mautic Twig and JavaScript sources; it does not use a browser or check element visibility.

```console
node Tests/selectors/check-selectors.mjs --core 6.0.9=/path/to/mautic-6/app/bundles --core 7.1.3=/path/to/mautic-7/app/bundles
```

`Tests/selectors/allowlist.json` documents selectors generated at runtime, the Mautic versions they apply to, and the source evidence for each exception.
