# reify-asi: command line DFM feature recognizer.
#
# Build (normally done by scripts/bootstrap-asi.sh):
#   cmake -S native/reify-asi -B build -DCMAKE_PREFIX_PATH=<occt prefix>
#         -DASI_SRC=<AnalysisSitus-v2024.2/src> -DEIGEN_INCLUDE_DIR=<eigen3>
#
# Only the asiAlgo / asiActiveData sources listed in cmake/asi_sources.cmake are
# compiled, with USE_MOBIUS, USE_RAPIDJSON and all GUI code off. The patched
# asiAlgo_Utils.cpp (patches/asiAlgo-utils-no-x11.patch) must already be applied
# to ASI_SRC.
cmake_minimum_required(VERSION 3.16)
project(reify-asi VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

set(ASI_SRC "" CACHE PATH "Analysis Situs v2024.2 src/ directory")
set(EIGEN_INCLUDE_DIR "" CACHE PATH "Eigen 3 include directory (contains Eigen/Dense)")

if(NOT ASI_SRC OR NOT EXISTS "${ASI_SRC}/asiAlgo/asiAlgo.h")
  message(FATAL_ERROR "ASI_SRC must point at the Analysis Situs src/ directory (got '${ASI_SRC}')")
endif()
if(NOT EXISTS "${EIGEN_INCLUDE_DIR}/Eigen/Dense")
  message(FATAL_ERROR "EIGEN_INCLUDE_DIR must contain Eigen/Dense (got '${EIGEN_INCLUDE_DIR}')")
endif()

# The no-X11 patch removes the GUI screenshot code. Refuse to build an unpatched tree.
file(READ "${ASI_SRC}/asiAlgo/auxiliary/asiAlgo_Utils.cpp" _asi_utils)
if(NOT _asi_utils MATCHES "reify-asi: rendering is not available")
  message(FATAL_ERROR "patches/asiAlgo-utils-no-x11.patch is not applied to ${ASI_SRC}")
endif()

find_package(OpenCASCADE REQUIRED)
if(NOT OpenCASCADE_VERSION MATCHES "^7\\.6\\.")
  message(FATAL_ERROR "reify-asi needs OCCT 7.6.x (found ${OpenCASCADE_VERSION})")
endif()

include(cmake/asi_sources.cmake)

# Every directory under asiAlgo/ and asiActiveData/ is an include root.
file(GLOB_RECURSE _asi_dirs LIST_DIRECTORIES true
     "${ASI_SRC}/asiAlgo/*" "${ASI_SRC}/asiActiveData/*")
set(ASI_INCLUDE_DIRS "${ASI_SRC}/asiAlgo" "${ASI_SRC}/asiActiveData")
foreach(_d IN LISTS _asi_dirs)
  if(IS_DIRECTORY "${_d}")
    list(APPEND ASI_INCLUDE_DIRS "${_d}")
  endif()
endforeach()

set(ASI_ABS_SOURCES)
foreach(_s IN LISTS ASI_SOURCES)
  list(APPEND ASI_ABS_SOURCES "${ASI_SRC}/${_s}")
endforeach()

add_library(asialgo STATIC ${ASI_ABS_SOURCES})
target_include_directories(asialgo SYSTEM PRIVATE
  ${OpenCASCADE_INCLUDE_DIR} ${EIGEN_INCLUDE_DIR} ${ASI_INCLUDE_DIRS})
target_compile_definitions(asialgo PRIVATE BUILD_ALGO_ONLY USE_GCC)
target_compile_options(asialgo PRIVATE -w)

add_executable(reify-asi
  src/main.cpp
  src/analyze.cpp
  src/faces.cpp
  src/holes.cpp
  src/cavities.cpp
  src/blends.cpp
  src/thickness.cpp
  src/dihedral.cpp
  src/json.cpp)
target_include_directories(reify-asi PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/src
  ${OpenCASCADE_INCLUDE_DIR} ${EIGEN_INCLUDE_DIR} ${ASI_INCLUDE_DIRS})
target_compile_definitions(reify-asi PRIVATE REIFY_ASI_VERSION="${PROJECT_VERSION}")
target_compile_options(reify-asi PRIVATE -Wall -Wextra -Wno-unused-parameter)
target_link_libraries(reify-asi PRIVATE asialgo)

# Link only the OCCT toolkits that are used; --as-needed drops the rest from DT_NEEDED.
set(_occt_tk TKernel TKMath TKG2d TKG3d TKGeomBase TKBRep TKGeomAlgo TKTopAlgo TKPrim
             TKBO TKShHealing TKBool TKHLR TKFillet TKOffset TKFeat TKMesh TKCDF TKLCAF
             TKCAF TKStd TKXSBase
             # Pulled in by asiAlgo_Utils.cpp (file import/export helpers), not by the algorithms.
             TKIGES TKSTL)
target_link_libraries(reify-asi PRIVATE ${_occt_tk})
if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU" OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  target_link_options(reify-asi PRIVATE "LINKER:--as-needed")
  target_link_libraries(reify-asi PRIVATE pthread dl m)
endif()

install(TARGETS reify-asi RUNTIME DESTINATION bin)
