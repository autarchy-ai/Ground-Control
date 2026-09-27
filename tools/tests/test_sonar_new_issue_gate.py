"""The SonarCloud new-issue gate queries in a form an organization token is accepted for."""

from __future__ import annotations

import unittest
import urllib.parse

from tools.sonar.assert_no_new_issues import AnalysisScope, build_request_url, parse_args


def query(url: str) -> dict[str, list[str]]:
    """The decoded query string of a request URL."""
    return urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)


class NewIssueGateRequestTest(unittest.TestCase):
    def test_an_organization_scopes_the_issue_query(self) -> None:
        # SonarCloud refuses an organization token's issue search without it (HTTP 400).
        args = parse_args(["--project-key", "p", "--organization", "org", "--pull-request", "7"])
        url = build_request_url(args.project_key, AnalysisScope("pullRequest", "7"), 1, args.organization)
        self.assertEqual(query(url)["organization"], ["org"])
        self.assertEqual(query(url)["pullRequest"], ["7"])

    def test_the_query_omits_an_organization_that_was_not_given(self) -> None:
        url = build_request_url("p", AnalysisScope("branch", "dev"), 1, None)
        self.assertNotIn("organization", query(url))


if __name__ == "__main__":
    unittest.main()
