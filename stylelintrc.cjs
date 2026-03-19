module.exports = {
    extends: ["stylelint-config-standard-scss"],
    customSyntax: "postcss-scss",
    rules: {
        indentation: 4,                 // 4 пробела — как в EditorConfig
        "color-hex-case": "lower",
        "number-max-precision": 2,
        "at-rule-empty-line-before": null
    },
    ignoreFiles: ["build/**"]
};
