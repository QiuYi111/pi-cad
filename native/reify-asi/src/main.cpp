// reify-asi entry point. See README.md for the CLI and exit codes.
#include "reify_asi.hpp"

#include <cstdio>
#include <exception>

int main(int argc, char** argv)
{
  try
  {
    return runCli(argc, argv);
  }
  catch (const CliError& e)
  {
    std::fprintf(stderr, "reify-asi: %s\n", e.what());
    return e.code;
  }
  catch (const std::exception& e)
  {
    std::fprintf(stderr, "reify-asi: unexpected error: %s\n", e.what());
    return EXIT_ANALYSIS;
  }
  catch (...)
  {
    std::fprintf(stderr, "reify-asi: unexpected error\n");
    return EXIT_ANALYSIS;
  }
}
